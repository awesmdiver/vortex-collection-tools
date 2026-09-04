'use strict';
// Duplicate Version Cleanup -- thin Express handlers. Real logic lives in
// lib/duplicate-version-cleanup.js (detection + the 8-step remove/redownload/reinstall/reassign
// recipe). See design/SPEC-duplicate-version-cleanup-tool.md and
// diagnostics/2026-09-01-duplicate-download-persistence-investigation.md for the full "why".
//
// /scan is a single, synchronous read (no per-item progress to report -- it's one live-state read,
// not a batch of independent operations; the frontend shows a plain spinner while it awaits, matching
// this app's own "don't draw a fill-bar the underlying operation can't honestly back" rule). /clean is
// a real destructive batch, so it gets the same POST-starts-202/GET-.../events-subscribes SSE shape
// every other long-running write in this app uses (see web/sse-session.js).

const express = require('express');
const dvc = require('../lib/duplicate-version-cleanup');
const helperClient = require('../lib/vortex-helper-client');
const syncLib = require('../lib/vortex-sync/lib');
const { listPickableCollections } = require('../lib/missing-files-scan');
const { createSseSession } = require('./sse-session');

const cleanSession = createSseSession();
// Same real "checkable flag between iterations" shape clear-update-flags-routes.js's own
// clearCancelled already established (web/clear-update-flags-routes.js's own /clear/cancel) --
// sse-session.js itself has no cancel machinery of its own, this is the established per-tool
// pattern to reuse. A cancelled clean is a real, honest partial result, never an error: whatever
// groups already finished before this landed genuinely stayed cleaned up (their Helper writes
// already happened and can't be un-sent) -- only groups that hadn't STARTED yet are skipped. The
// group actively mid-flight when Cancel is clicked always finishes its own remove/redownload/
// reinstall/reassign sequence first, same reasoning Update Collection v2's own Cancel (confirm-modal-
// only, never mid-Apply) and Rebuild Missing Files' own Cancel (Scan-only, never mid-Extract) already
// apply -- aborting a real multi-step write partway through risks leaving Vortex/staging in an
// inconsistent state.
let cleanCancelled = false;

function createDuplicateVersionCleanupRouter(config) {
    const router = express.Router();
    const { staging, downloads } = config;

    function requireConfigured(res) {
        if (staging && downloads) return true;
        res.status(400).json({ error: 'not-configured', message: 'Set up the staging and downloads folders under Settings first.' });
        return false;
    }

    async function requireHelper(res) {
        const available = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!available) {
            res.status(409).json({
                error: 'helper-unavailable',
                message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) for this tool -- there is no offline equivalent for the real remove/reinstall work it does.',
            });
            return false;
        }
        return true;
    }

    // Real, named picker options -- a plain filesystem read of each staged collection's own
    // collection.json (same primitive Rebuild Missing Files' own GET /collections already uses, see
    // lib/missing-files-scan.js's listPickableCollections), NOT Vortex's live attrs. Vortex's live
    // customFileName/modName are frequently unset, which let a raw "vortex_collection_<id>" leak
    // straight into the picker before this fix -- collection.json's own authored info.name is real
    // and reliable. Mirrors Rebuild Missing Files' own checkbox-grid picker shape exactly (same
    // .coll-card/.picker-grid component, ported client-side).
    router.get('/collections', (req, res) => {
        if (!staging) return res.json({ configured: false, installed: [], workshop: [] });
        try {
            const { installed, workshop } = listPickableCollections(staging);
            res.json({ configured: true, installed, workshop });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Real read (single live-state pass, ~a few seconds on a large install) -- the group list shaped
    // for Screen 2's table. `collectionModIds`, when given a non-empty array, scopes detection to the
    // UNION of those collections' own real members (see lib/duplicate-version-cleanup.js's own
    // scanForDuplicates) -- zero/omitted scans the whole install, the deliberate default.
    router.post('/scan', async (req, res) => {
        if (!requireConfigured(res)) return;
        if (!(await requireHelper(res))) return;
        const collectionModIds = Array.isArray(req.body?.collectionModIds) ? req.body.collectionModIds : [];
        try {
            const { groups } = await dvc.scanForDuplicates({ collectionModIds });
            res.json({ groups });
        } catch (e) {
            if (e.code === 'COLLECTION_NOT_FOUND') return res.status(404).json({ error: e.message });
            console.error(`[duplicate-version-cleanup-routes] /scan failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/clean/events', (req, res) => {
        if (!cleanSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        cleanSession.subscribe(res, { afterSeq });
    });

    // Stops the batch from starting any FURTHER group -- never an instant mid-write abort. See
    // cleanCancelled's own header comment above for the full reasoning.
    router.post('/clean/cancel', (req, res) => {
        if (!cleanSession.isActive()) {
            return res.status(404).json({ error: 'No cleanup is currently running.' });
        }
        cleanCancelled = true;
        res.json({ ok: true });
    });

    // Body: { selections: [{ modId, installedVortexModId }, ...] } -- the checked GROUPS, identified
    // by their real Nexus modId + the currently-installed Vortex mod id (never a raw copy of the
    // scan's own removable[] list -- see below, this route re-derives exactly what's safe to remove
    // fresh, right before touching anything, the same "never trust a client-held diff that may be
    // stale" principle every other real write in this app follows).
    router.post('/clean', async (req, res) => {
        if (!requireConfigured(res)) return;
        if (!(await requireHelper(res))) return;
        const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
        if (selections.length === 0) return res.status(400).json({ error: 'Nothing selected to clean up.' });
        if (cleanSession.isActive()) return res.status(409).json({ error: 'A cleanup is already in progress.' });

        cleanCancelled = false;
        const mySession = cleanSession.start({ id: `clean-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (cleanSession.get() === mySession) cleanSession.emit(event);
        };

        (async () => {
            try {
                console.log(`[duplicate-version-cleanup-routes] CLEAN START: ${selections.length} group(s) selected.`);
                // Fresh, full re-scan right before any write -- never trust the client's own
                // (possibly minutes-stale) copy of which entries are 'orphan' vs 'legit'. Only a group
                // that STILL has at least one real orphan entry, for the SAME survivor the client
                // selected, is actually touched -- anything that changed since the original scan
                // (another tool removed it, a 'legit' reference appeared/disappeared) is honestly
                // reported, not silently forced through.
                const { groups: freshGroups } = await dvc.scanForDuplicates({});
                // Nothing to cancel during the re-scan above (already finished by now) -- this is the
                // real moment a cancel becomes meaningful, same as clear-update-flags' own
                // onSpawn-fired 'cancellable' event.
                emitIfCurrent({ type: 'cancellable' });
                const results = [];
                for (let i = 0; i < selections.length; i += 1) {
                    if (cleanCancelled) {
                        console.log(`[duplicate-version-cleanup-routes] CLEAN cancelled after ${i}/${selections.length} group(s) -- not starting the rest.`);
                        break;
                    }
                    const sel = selections[i];
                    const group = freshGroups.find((g) => String(g.modId) === String(sel.modId) && g.installedVortexModId === sel.installedVortexModId);
                    if (!group) {
                        const msg = 'This mod no longer shows any duplicate versions -- it may have already been cleaned up, or the survivor changed. Skipped.';
                        console.warn(`[duplicate-version-cleanup-routes] clean: modId=${sel.modId} not found in a fresh re-scan -- skipping.`);
                        results.push({ ok: true, name: sel.modId, skipped: true, error: msg });
                        emitIfCurrent({ type: 'group-complete', index: i + 1, total: selections.length, name: sel.modId, ok: true, skipped: true, error: msg });
                        continue;
                    }
                    const orphanDownloadIds = group.removable.filter((r) => r.kind === 'orphan').map((r) => r.downloadId);
                    emitIfCurrent({ type: 'group-start', index: i + 1, total: selections.length, name: group.mod });
                    if (orphanDownloadIds.length === 0) {
                        const msg = 'No orphaned versions left to remove for this mod (it may already be clean, or the remaining entries are all flagged) -- skipped.';
                        results.push({ ok: true, name: group.mod, skipped: true, error: msg });
                        emitIfCurrent({ type: 'group-complete', index: i + 1, total: selections.length, name: group.mod, ok: true, skipped: true, error: msg });
                        continue;
                    }
                    const result = await dvc.cleanupGroup({
                        modId: group.modId, installedVortexModId: group.installedVortexModId,
                        orphanDownloadIds, downloadsDir: downloads, stagingDir: staging,
                        onPhase: (phase) => emitIfCurrent({ type: 'group-phase', index: i + 1, total: selections.length, name: group.mod, phase }),
                    });
                    results.push(result);
                    emitIfCurrent({ type: 'group-complete', index: i + 1, total: selections.length, name: result.name, ok: result.ok, error: result.error, refusedOrphans: result.refusedOrphans });
                }
                const okCount = results.filter((r) => r.ok).length;
                console.log(`[duplicate-version-cleanup-routes] CLEAN END: ${okCount}/${results.length} group(s) ok${cleanCancelled ? ` (cancelled -- ${selections.length - results.length} group(s) never attempted)` : ''}.`);
                emitIfCurrent({ type: 'clean-complete', done: true, results, cancelled: cleanCancelled, totalSelected: selections.length });
            } catch (e) {
                console.error(`[duplicate-version-cleanup-routes] clean FAILED: ${e.message}`);
                emitIfCurrent({ type: 'clean-error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Same real fire-and-poll deploy pattern Update Collection v2's own /deploy-all already
    // established (web/update-collection-v2-routes.js) -- a per-group deploy is deliberately never
    // done inline (matching that same file's own "no per-mod deploy in this loop" architecture call);
    // one real, full deploy at the end covers every mod this cleanup just reinstalled.
    router.post('/deploy-all', async (req, res) => {
        if (!(await requireHelper(res))) return;
        res.json({ ok: true });
        (async () => {
            try {
                await helperClient.deployAllMods();
            } catch (e) {
                console.error(`[duplicate-version-cleanup-routes] /deploy-all failed: ${e.message}`);
            }
        })();
    });

    router.get('/deploy-all/progress', async (req, res) => {
        const progress = await helperClient.getDeployAllProgress();
        if (!progress) return res.json({ active: false, done: false, unknown: true });
        res.json(progress);
    });

    return router;
}

module.exports = { createDuplicateVersionCleanupRouter };
