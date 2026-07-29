'use strict';
// Thin Express handlers for the Update Collection flow -- all real logic lives in
// lib/sync-runner.js (this project is 100% web-UI-driven; sync-cli.js still calls
// lib/vortex-sync/lib.js directly instead, see TECHNICAL.md's Future Work). Each of these phases is
// a single atomic backend operation (not a multi-step loop), so plain async request/response is used
// rather than SSE -- see web/sync-lock.js's own comment for why. Nothing destructive happens without
// a fresh Vortex-closed check, mirroring the Rebuild Collection flow's gate exactly.

const express = require('express');
const fs = require('fs');

const runner = require('../lib/sync-runner');
const { buildHtmlReport } = require('../lib/vortex-sync/report');
const syncLock = require('./sync-lock');
const backupRatioDismissState = require('../lib/backup-ratio-dismiss-state');

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Same dark-theme app-header/nav/back-button/table/status-badge-filter structure as Rebuild
// Collection's own /logs/view/:filename report page, per an explicit request to keep this
// consistent rather than inventing a new look. A real page navigation (not window.open in a new
// tab) -- a Back button wouldn't make sense/would break the flow in a separate tab, per direct
// feedback. The Back link round-trips collectionModId/profileId so the Update Collection page can
// restore the exact collection/profile you were working on, instead of resetting to "-- Select
// Collection --" -- confirmed live this was lost otherwise, since this is a real page reload, not
// an SPA route change.
function renderIgnoredDisabledReport({ collectionModId, profileId, collectionName, profileName, rows }) {
    const tableRows = rows.map((r) => `<tr data-status="${escHtml(r.status)}"><td>${escHtml(r.name)}</td>` +
        `<td><span class="status-pill status-pill--${r.status.toLowerCase()}">${escHtml(r.status)}</span></td></tr>`).join('');
    const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    const badges = Object.entries(counts)
        .map(([status, count]) => `<span class="badge badge--${status.toLowerCase()} badge--clickable" data-status="${escHtml(status)}"><span class="badge__count">${count}</span> ${escHtml(status)}</span>`)
        .join('') + `<span class="badge badge--show-all" data-status="">Show all</span>`;
    const backHref = `/?area=sync&collectionModId=${encodeURIComponent(collectionModId)}&profileId=${encodeURIComponent(profileId)}`;
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Vortex Collection Tools — Ignored/Disabled Mods</title>
<link rel="stylesheet" href="/styles.css"></head>
<body>
<header class="app-header">
  <div class="app-header__title">
    <span class="app-header__logo">&#9881;</span>
    <span>Vortex Collection Tools</span>
  </div>
  <nav class="app-nav">
    <a href="/?area=rebuild" class="nav-tab">Rebuild Collection</a>
    <a href="/?area=sync" class="nav-tab nav-tab--active">Update Collection</a>
    <a href="/?area=settings" class="nav-tab">Settings</a>
    <a href="/?reports=stats" class="nav-tab">Reports</a>
  </nav>
  <div class="app-header__meta">Update Collection &gt; Ignored/Disabled Mods</div>
</header>
<main class="app-main">
<a href="${escHtml(backHref)}" class="btn btn--nav btn--back">&larr; Back to Update Collection</a>
<div class="view-header">
  <h1>Ignored/Disabled Mods</h1>
  <p class="muted">${escHtml(collectionName)} &mdash; profile ${escHtml(profileName)}</p>
</div>
<div class="summary-badges" id="statusBadges">${badges}</div>
<div class="plan-table-wrap"><table class="plan-table">
<thead><tr><th>Mod</th><th>Status</th></tr></thead>
<tbody id="modListTableBody">${tableRows || `<tr><td colspan="2" class="muted">No mods are currently ignored or disabled in this collection.</td></tr>`}</tbody>
</table></div>
</main>
<script>
// Same badge-filter behavior as Rebuild Collection's own log-view report -- click a badge to show
// only that status, "Show all" to clear the filter, active filter persisted in the URL (no
// navigation) so a reload restores it instead of resetting.
function applyStatusFilter(status) {
  document.querySelectorAll('#statusBadges .badge').forEach(function (b) { b.classList.remove('badge--filter-active'); });
  var rows = document.querySelectorAll('#modListTableBody tr');
  if (!status) {
    rows.forEach(function (r) { r.style.display = ''; });
    return;
  }
  var badge = document.querySelector('#statusBadges .badge--clickable[data-status="' + CSS.escape(status) + '"]');
  if (badge) badge.classList.add('badge--filter-active');
  rows.forEach(function (r) { r.style.display = r.dataset.status === status ? '' : 'none'; });
}
document.getElementById('statusBadges').addEventListener('click', function (e) {
  var badge = e.target.closest('.badge--clickable, .badge--show-all');
  if (!badge) return;
  var status = badge.dataset.status;
  applyStatusFilter(status);
  var url = new URL(location.href);
  if (status) url.searchParams.set('status', status); else url.searchParams.delete('status');
  history.replaceState(null, '', url);
});
applyStatusFilter(new URLSearchParams(location.search).get('status') || '');
</script>
</body></html>`;
}

function createSyncRouter(config) {
    const router = express.Router();
    const { staging, state, syncBackupRoot } = config;
    const syncLib = runner.loadSyncLib();

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    router.get('/collections', (req, res) => {
        // No staging folder configured yet (fresh install) -- expected, not an error.
        if (!staging) return res.json({ collections: [], configured: false });
        try {
            res.json({ collections: runner.listInstalledCollections(staging) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/vortex-status', (req, res) => {
        res.json({ running: syncLib.isVortexRunning() });
    });

    // Standalone Vortex-version compatibility check -- run once at app startup (shell.js), NOT tied
    // to Apply Ignores' Preview flow (it used to be; decoupled per explicit request, since "is this
    // Vortex install one this tool was actually tested against" is a whole-app question, not
    // specific to any one step). Vortex running is a normal, common state to load this app in, not
    // an error -- reported as vortexRunning: true so the startup check can just skip silently and
    // re-check on next launch, instead of surfacing a scary error for an entirely expected condition.
    router.get('/vortex-version-check', async (req, res) => {
        if (syncLib.isVortexRunning()) return res.json({ vortexRunning: true });
        try {
            const { version, tested } = await runner.checkVortexVersionCompat(state);
            res.json({ vortexRunning: false, vortexVersion: version, versionTested: tested });
        } catch {
            // Anything else (e.g. no state.v2 yet on a brand new Vortex install) -- treat as
            // "nothing to warn about" rather than erroring the whole page load over it.
            res.json({ vortexRunning: false, vortexVersion: null, versionTested: true });
        }
    });

    router.get('/profiles', async (req, res) => {
        if (vortexRunningGate(res)) return;
        try {
            const { profiles, lastActiveProfileId } = await runner.listProfiles(state);
            res.json({ profiles, lastActiveProfileId });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/backups', (req, res) => {
        // No auto-fallback to a hardcoded folder -- confirmed live this was confusing (a real
        // backup silently landed inside this project's own lib/vortex-sync/backups/, not anywhere
        // resembling a "Vortex" location, with no indication of where to actually go find it).
        // Same "not configured yet" shape as /collections above, mirroring Rebuild Collection's own
        // staging/downloads requirement exactly -- nothing works here until this is explicitly set.
        if (!syncBackupRoot) return res.json({ backups: [], configured: false });
        res.json({ backups: runner.listBackups(syncBackupRoot), configured: true });
    });

    // ---------- Read-only reports (callable any time, regardless of workflow phase) ----------
    // collectionName/profileName are supplied by the client (it already has both from the pickers
    // above) purely for display in the report's subtitle -- avoids a second DB round-trip just to
    // look up a name the caller already knows.

    // One combined report (not two separate ones) -- a mod that's both ignored AND disabled gets
    // two rows, one per status, rather than a merged "Ignored, Disabled" label; keeps each row a
    // single plain fact rather than needing its own combined-status vocabulary.
    router.get('/list-mods/report', async (req, res) => {
        const { modId, profileId, collectionName, profileName } = req.query;
        if (!modId || !profileId) return res.status(400).send('modId and profileId query params are required.');
        if (syncLib.isVortexRunning()) return res.status(409).send("Vortex is currently running. Close it completely and try again.");
        try {
            const [ignored, disabled] = await Promise.all([
                runner.listIgnoredMods({ stateDir: state, modId }),
                runner.listDisabledMods({ stateDir: state, modId, profileId }),
            ]);
            const rows = [
                ...ignored.map((m) => ({ name: m.name, status: 'Ignored' })),
                ...disabled.map((m) => ({ name: m.name, status: 'Disabled' })),
            ].sort((a, b) => a.name.localeCompare(b.name));
            const html = renderIgnoredDisabledReport({
                collectionModId: modId,
                profileId,
                collectionName: collectionName || modId,
                profileName: profileName || profileId,
                rows,
            });
            res.type('html').send(html);
        } catch (e) {
            res.status(500).send(`Error: ${escHtml(e.message)}`);
        }
    });

    // Phase 1 -- run BEFORE clicking "Update" on the collection in Vortex. Read-only (a temp copy
    // of state.v2), but Vortex must still be closed to safely copy it.
    router.post('/backup', async (req, res) => {
        const { collectionModId, profileId } = req.body || {};
        if (!collectionModId) return res.status(400).json({ error: 'collectionModId is required.' });
        if (!staging) return res.status(400).json({ error: 'not-configured', message: 'Staging folder is not configured yet -- open Settings to set it up.' });
        if (!syncBackupRoot) return res.status(400).json({ error: 'not-configured', message: 'Update Collection backups folder is not configured yet -- open Settings to set it up.' });
        if (vortexRunningGate(res)) return;
        // Rare but confirmed real: the collection was updated to a newer revision (Vortex renames
        // the staging folder to a new archive-derived id) since this page last loaded, so the
        // client's own in-memory collectionModId no longer corresponds to anything -- not on disk,
        // not in Vortex's state. Caught HERE, before ever touching the state DB, so it surfaces as
        // its own clear, distinct error instead of falling into getRules()'s generic "mod not found"
        // message (which reads as a possible crash/transient issue, not "this id is simply gone").
        const matchedCollection = runner.listInstalledCollections(staging).find((c) => c.modId === collectionModId);
        if (!matchedCollection) {
            return res.status(409).json({
                error: 'collection-stale',
                message: 'The version of the collection you are attempting to create a backup for is no longer available. You will need to refresh this collection.',
            });
        }
        try {
            const snapshot = await runner.captureBackupSnapshot({ stateDir: state, stagingDir: staging, collectionModId, profileId });
            const filePath = runner.saveBackupSnapshot(snapshot, syncBackupRoot);
            // oldMods is the full collection.json member list (null only if it couldn't be read) --
            // the denominator the UI needs to flag an ignored/disabled COUNT that's fine on its own
            // but way out of proportion for the collection's actual size (see sync-app.js's
            // buildBackupRatioWarning). ratioWarningDismissed lets the client skip that warning
            // entirely for a collection the user has already marked "normal" via
            // POST /backup-ratio-dismiss, without a second round-trip just to check -- keyed by
            // matchedCollection.name (NOT collectionModId, which changes across every update -- see
            // lib/backup-ratio-dismiss-state.js's own comment), resolved fresh from the same
            // just-verified-still-installed lookup above rather than trusting a client-supplied name.
            res.json({
                ok: true, filePath,
                ignoredCount: snapshot.ignored.length,
                disabledCount: snapshot.disabled.length,
                totalCount: snapshot.oldMods ? snapshot.oldMods.length : null,
                ratioWarningDismissed: backupRatioDismissState.isDismissed(matchedCollection.name),
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Best-effort follow-up ONLY -- meant to be called right after /backup succeeds. Never throws a
    // real error to the client (see runner.checkBackupFreshness's own comment): worst case is
    // { checked: false }, which the UI just treats as "no freshness warning to show", not a failure.
    // No vortexRunningGate -- if Vortex somehow got reopened between the two calls, the underlying
    // read just fails and checkBackupFreshness swallows it the same as any other error.
    router.post('/backup/check-freshness', async (req, res) => {
        const { collectionModId, profileId } = req.body || {};
        if (!collectionModId) return res.status(400).json({ error: 'collectionModId is required.' });
        const result = await runner.checkBackupFreshness({ stateDir: state, collectionModId, profileId });
        res.json(result);
    });

    // Phase 2 dry-run -- read-only, safe to call any time. The Vortex-version-compat check used to
    // be run again here too, but that's now a standalone startup check (GET /vortex-version-check,
    // surfaced once at app load by shell.js) rather than something re-checked on every Preview click.
    router.post('/apply-ignores/preview', async (req, res) => {
        const { modId, backupPath } = req.body || {};
        if (!modId || !backupPath) return res.status(400).json({ error: 'modId and backupPath are required.' });
        if (vortexRunningGate(res)) return;
        try {
            const snapshot = runner.loadBackup(backupPath);
            const { changed, unmatched, identityWarning } = await runner.previewApplyIgnores({ stateDir: state, modId, ignoredRefs: snapshot.ignored });
            res.json({ changed, unmatched, identityWarning });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Phase 2 real write -- the only step that actually prevents Vortex from installing ignored
    // mods. lib/vortex-sync/lib.js's withLiveStateDb takes a full state.v2 backup first and refuses
    // if Vortex is running or the backup can't be completed.
    router.post('/apply-ignores/apply', async (req, res) => {
        const { modId, backupPath } = req.body || {};
        if (!modId || !backupPath) return res.status(400).json({ error: 'modId and backupPath are required.' });
        if (vortexRunningGate(res)) return;
        try {
            syncLock.acquire('apply-ignores');
        } catch (e) {
            return res.status(409).json({ error: 'write-active', message: e.message });
        }
        try {
            const snapshot = runner.loadBackup(backupPath);
            const result = await runner.applyIgnores({ stateDir: state, modId, ignoredRefs: snapshot.ignored });
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            syncLock.release();
        }
    });

    // Phase 3 dry-run -- read-only. Only meaningful after Resume finishes (a dependent mod's id
    // doesn't exist in state until Vortex actually installs it) -- run too early and it just finds
    // fewer/zero matches, surfaced via `missing` rather than treated as an error.
    router.post('/apply-disables/preview', async (req, res) => {
        const { backupPath } = req.body || {};
        if (!backupPath) return res.status(400).json({ error: 'backupPath is required.' });
        if (vortexRunningGate(res)) return;
        try {
            const snapshot = runner.loadBackup(backupPath);
            if (snapshot.disabled.length === 0) {
                res.json({ matches: [], missing: [], nothingToDo: true });
                return;
            }
            const { matches, identityWarning } = await runner.previewApplyDisables({ stateDir: state, disabledRefs: snapshot.disabled });
            const foundNames = new Set(matches.map((m) => m.matchedRef.name));
            const missing = snapshot.disabled.filter((d) => !foundNames.has(d.name));
            res.json({ matches, missing, nothingToDo: false, identityWarning });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Phase 3 real write -- same live-state safety wrapper as apply-ignores/apply.
    router.post('/apply-disables/apply', async (req, res) => {
        const { profileId, backupPath } = req.body || {};
        if (!profileId || !backupPath) return res.status(400).json({ error: 'profileId and backupPath are required.' });
        if (vortexRunningGate(res)) return;
        try {
            syncLock.acquire('apply-disables');
        } catch (e) {
            return res.status(409).json({ error: 'write-active', message: e.message });
        }
        try {
            const snapshot = runner.loadBackup(backupPath);
            const result = await runner.applyDisables({ stateDir: state, profileId, disabledRefs: snapshot.disabled });
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            syncLock.release();
        }
    });

    // ---------- Recovery: restore a previous state.v2 backup ----------
    // Every Phase 2/3 write above takes a full state.v2 backup first (see lib/vortex-sync/lib.js's
    // backupLiveState) -- these two routes are the other half of that safety net, letting you
    // actually use one of those backups if something goes wrong (e.g. the native LevelDB crash risk
    // documented in TECHNICAL.md's Safety notes).

    // Pure directory listing (this project's own state-backups folder) -- never touches Vortex's
    // state DB at all, so no Vortex-closed gate needed here.
    router.get('/state-backups', (req, res) => {
        try {
            res.json({ backups: runner.listStateBackups() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The actual restore -- same live-state safety wrapper (Vortex-closed gate, write lock) as
    // apply-ignores/apply-disables above, since this also writes to the live state.v2 directory.
    router.post('/restore-state', async (req, res) => {
        const { backupDir } = req.body || {};
        if (!backupDir) return res.status(400).json({ error: 'backupDir is required.' });
        if (vortexRunningGate(res)) return;
        try {
            syncLock.acquire('restore-state');
        } catch (e) {
            return res.status(409).json({ error: 'write-active', message: e.message });
        }
        try {
            const result = await runner.restoreState({ stateDir: state, backupDir });
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            syncLock.release();
        }
    });

    // ---------- Settings page: backup cleanup ----------
    // Two SEPARATE backup stores, each gets its own info+delete pair -- mirrors Rebuild Collection's
    // own /api/settings/backups-info + /delete-backups pattern exactly, just split in two since
    // these are genuinely different things (one is small manual snapshots, the other is automatic
    // full-DB safety copies) rather than one combined button.

    // Collection snapshot backups (syncBackupRoot) -- the ignored/disabled-mod JSON files created via
    // "Create Backup" in step 1. Same "not configured yet" shape as GET /backups above.
    router.get('/backups-info', (req, res) => {
        if (!syncBackupRoot) return res.json({ backupRoot: null, count: 0 });
        res.json({ backupRoot: syncBackupRoot, count: runner.listBackups(syncBackupRoot).length });
    });
    router.post('/delete-backups', (req, res) => {
        if (!syncBackupRoot) return res.status(400).json({ error: 'No Update Collection backups folder is configured.' });
        const backups = runner.listBackups(syncBackupRoot);
        for (const b of backups) fs.rmSync(b.filePath, { force: true });
        res.json({ deletedCount: backups.length });
    });

    // State.v2 safety backups (lib/vortex-sync/state-backups/, gitignored, fixed location -- not
    // user-configurable) -- full copies of Vortex's live database, taken automatically before every
    // write (see lib.js's backupLiveState). Deleting these is always safe on its own terms (they're
    // a defensive safety net, never read by the normal workflow unless a restore is actually needed
    // via POST /restore-state above) -- no Vortex-closed gate needed, this never touches live state.
    router.get('/state-backups-info', (req, res) => {
        try {
            res.json({ count: runner.listStateBackups().length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.post('/delete-state-backups', (req, res) => {
        try {
            const backups = runner.listStateBackups();
            for (const b of backups) fs.rmSync(b.dir, { recursive: true, force: true });
            res.json({ deletedCount: backups.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---------- Backup ratio warning dismissals ("This is normal for this collection") ----------
    // Keyed by collection NAME, not modId -- see lib/backup-ratio-dismiss-state.js's own comment for
    // why (modId changes on every update, confirmed not stable even in its "nexusModId" segment).

    router.post('/backup-ratio-dismiss', (req, res) => {
        const { collectionName } = req.body || {};
        if (!collectionName) return res.status(400).json({ error: 'collectionName is required.' });
        backupRatioDismissState.setDismissed(collectionName);
        res.json({ ok: true });
    });

    // Settings page: how many collections are currently silenced, and the reset button.
    router.get('/backup-ratio-dismiss-info', (req, res) => {
        res.json({ count: backupRatioDismissState.getDismissedCount() });
    });
    router.post('/backup-ratio-dismiss-reset', (req, res) => {
        backupRatioDismissState.resetAll();
        res.json({ ok: true, count: 0 });
    });

    // Optional Compare -- pure computation, never touches the state DB (matches lib.js's own
    // computeSync/writePatchedCollection scope exactly: audit-only, does not control what Vortex
    // installs). Renders the existing buildHtmlReport HTML directly, mirroring the Rebuild flow's
    // /logs/view/:filename pattern (a GET so it can be opened straight via window.open, no body).
    router.get('/compare/report', (req, res) => {
        const { backupPath, collectionPath } = req.query;
        if (!backupPath || !collectionPath) return res.status(400).send('backupPath and collectionPath query params are required.');
        try {
            const snapshot = runner.loadBackup(backupPath);
            const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
            const result = runner.compareCollectionAgainstBackup(collection, snapshot);
            const before = result.removedMods.length + result.keptMods.length;
            const after = result.keptMods.length;
            const html = buildHtmlReport({
                collectionInfo: { name: snapshot.collectionName },
                collectionModId: snapshot.collectionModId,
                sourcePath: collectionPath,
                outPath: null,
                applied: false,
                before, after, result,
            });
            res.type('html').send(html);
        } catch (e) {
            res.status(500).send(`Error: ${e.message}`);
        }
    });

    return router;
}

module.exports = { createSyncRouter };
