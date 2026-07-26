// Builds a self-contained HTML report comparing a source collection.json against the patched
// output: what the collection author added/removed between revisions (independent of anything the
// user personally ignored/disabled -- requires the backup to have captured the OLD collection.json's
// full mod list, see lib.js's extractModsForSnapshot; shows a "not available" note for older backups
// that predate this), what got removed (ignored), what's kept but currently disabled in Vortex, and
// any ignored mods that couldn't be matched in the new revision.
//
// Rendered inside an <iframe> under Reports > Update Compare Report (see web/public/stats-app.js's
// showUpdateCompareReport) sitting right next to the app's own Stats Report / Work Through Report --
// reuses THEIR shared look (styles.css, .summary-badges/.badge--clickable filtering one combined
// .plan-table, same as sync-routes.js's renderIgnoredDisabledReport) rather than inventing a
// separate style, per explicit direction that all three Reports sub-tabs should look and feel the
// same. No app-header/nav duplicated here -- the outer page already shows that above the iframe.
//
// The "plugin auto-disabled" / "needs a manual disable in Vortex" split (outPath-gated below) is
// ONLY meaningful when a patched collection.json was actually written (the CLI/terminal-menu's own
// writePatchedCollection flow) -- collection.json has no per-mod enable/disable field, so THAT
// mechanism can only pre-disable a kept-but-disabled mod by toggling its plugin file in the patched
// output, and has no recourse for mods with no plugin file at all. The web UI's Compare button never
// writes a patched file (outPath is always null there) -- it uses Apply Disables instead, which
// writes directly to Vortex's live state.v2 and disables a kept mod unconditionally, no plugin file
// required. Showing the "needs manual disable" status when outPath is null would incorrectly flag
// plugin-less mods as needing manual attention when Apply Disables already handled them for real.

const path = require('path');

// Vortex's own staging-folder naming convention (<Name>-<nexusModId>-<revision>-<timestamp>) --
// same regex as web/public/sync-app.js's own revisionFromModId, kept in sync with that one since
// both parse the identical id shape. Used to show which revision is being compared to which,
// instead of the raw internal id/file paths (neither means anything to the person reading this).
function revisionFromModId(modId) {
  const m = /-(\d+)-(\d+)$/.exec(modId || '');
  return m ? m[1] : null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function nexusUrl(mod) {
  const modId = mod.source?.modId;
  const fileId = mod.source?.fileId;
  if (!modId) return null;
  return `https://www.nexusmods.com/skyrimspecialedition/mods/${modId}` +
    (fileId ? `?tab=files&file_id=${fileId}` : '');
}

// One status per row -- every category shares the same Name/Author/Version/Category shape, so they
// combine into ONE filterable table instead of several separate ones, same "one combined report, not
// several" precedent as renderIgnoredDisabledReport (sync-routes.js). severity picks the shared
// badge/status-pill color (see styles.css's generic --info/--success/--warning/--critical/--neutral
// variants, same four-color convention as TECHNICAL.md's callout severities).
const STATUS_META = {
  'added-by-author': { label: 'Added by Author', severity: 'info' },
  'removed-by-author': { label: 'Removed by Author', severity: 'info' },
  'marked-ignored': { label: 'Marked Ignored', severity: 'neutral' },
  'kept-disabled': { label: 'Kept Disabled', severity: 'neutral' },
  'not-found-anymore': { label: 'Not Found Anymore', severity: 'warning' },
  'needs-manual-disable': { label: 'Needs Manual Disable', severity: 'critical' },
};

// Mods coming from collection.json entries expose category via .details.category; mods coming from
// a backup's ignored[] list (via ruleToRef in lib.js) expose it directly as .category instead --
// this reads whichever shape the caller has, so callers never need to know which one they've got.
function categoryOf(m) {
  return m.details?.category ?? m.category ?? '';
}

function tableRow(m, status) {
  const url = nexusUrl(m);
  const nameCell = url
    ? `<a href="${esc(url)}" class="mod-name-link" target="_blank" rel="noopener">${esc(m.name)}</a>`
    : esc(m.name);
  const meta = STATUS_META[status];
  return `<tr data-status="${esc(status)}">
    <td>${nameCell}</td>
    <td><span class="status-pill status-pill--${meta.severity}">${esc(meta.label)}</span></td>
    <td>${esc(m.author)}</td>
    <td>${esc(m.version)}</td>
    <td>${esc(categoryOf(m))}</td>
  </tr>`;
}

function filterBadge(status, count) {
  const meta = STATUS_META[status];
  return `<span class="badge badge--clickable badge--${meta.severity}" data-status="${esc(status)}">` +
    `<span class="badge__count">${count}</span> ${esc(meta.label)}</span>`;
}

function buildHtmlReport({ collectionInfo, collectionModId, sourcePath, outPath, applied, before, after, result }) {
  const name = collectionInfo?.name || collectionModId;

  // Rows for every status that HAS rows -- an empty category just never appears as a badge/row
  // rather than showing a permanent "0" (matches the old report's own philosophy: silence means no
  // problem, especially for the warning/critical severities below).
  const rowGroups = [
    { status: 'added-by-author', mods: result.authorAdded || [] },
    { status: 'removed-by-author', mods: result.authorRemoved || [] },
    { status: 'marked-ignored', mods: result.removedMods || [] },
    { status: 'kept-disabled', mods: result.disabledKept || [] },
    { status: 'not-found-anymore', mods: result.unmatched || [] },
  ];
  // Only meaningful when a patched collection.json was actually written -- see this file's header
  // comment. Always empty for the web UI's own Compare button (outPath always null there).
  if (outPath) rowGroups.push({ status: 'needs-manual-disable', mods: result.disabledNeedsManual || [] });

  const allRows = rowGroups.flatMap((g) => g.mods.map((m) => tableRow(m, g.status)));
  const badges = rowGroups.filter((g) => g.mods.length > 0).map((g) => filterBadge(g.status, g.mods.length));
  if (badges.length > 0) badges.push(`<span class="badge badge--show-all" data-status="">Show all</span>`);

  const authorDataAvailable = result.authorAdded !== null;
  const hasIgnoredRows = (result.removedMods || []).length > 0;
  const needsManualCount = outPath ? (result.disabledNeedsManual || []).length : 0;
  const generatedAt = new Date().toLocaleString();
  const ignoredCount = before - after;
  const modsSummary = ignoredCount > 0
    ? `This collection has ${before} mod(s). ${after} are installed -- the other ${ignoredCount} stay Ignored, exactly as you marked them.`
    : `This collection has ${before} mod(s), and all of them are installed.`;

  // What matters to the person reading this is WHICH revision was compared to which -- not the raw
  // internal id or file paths (neither means anything on its own). oldRev comes from the backup's
  // own modId; newRev is parsed from the CURRENT collection.json's containing folder name, since
  // Vortex names that folder after the modId too.
  const oldRev = revisionFromModId(collectionModId);
  const newRev = revisionFromModId(path.basename(path.dirname(sourcePath)));
  const revisionLine = (oldRev && newRev)
    ? `Comparing Revision ${oldRev} to Revision ${newRev}`
    : 'Comparing your backup to the current collection';

  const pluginsDisabledRows = (result.pluginsDisabled || []).map((p) => `<tr>
    <td>${esc(p.name)}</td>
    <td>${esc(p.forMod)}</td>
  </tr>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Compare Report — ${esc(name)}</title>
<link rel="stylesheet" href="/styles.css">
<script>
  // Matches whichever theme the user picked on the main Settings page (light/dark/system) --
  // localStorage is shared across same-origin documents, including this iframe, so this small
  // bootstrap keeps the report in sync with that choice instead of only following the OS/browser
  // default. Same snippet as index.html's own <head> bootstrap.
  var t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
</script>
<style>
  /* Only page-specific layout not already covered by styles.css -- everything else (colors, badges,
     tables, callouts) is the shared app stylesheet linked above. */
  body { padding: 24px 28px 60px; }
</style>
</head>
<body>
  <div class="view-header">
    <h1>${esc(name)}</h1>
    <p class="muted">${esc(modsSummary)}</p>
    <p class="muted" style="font-size: 12.5px;">${esc(revisionLine)} &middot; Generated ${esc(generatedAt)}</p>
  </div>

  ${!authorDataAvailable ? `<div class="callout callout--info">
    <p>Added/removed-by-author information isn't available for this backup -- it was made before this feature existed. Create a new backup next time to see what the collection author changed.</p>
  </div>` : ''}

  ${needsManualCount > 0 ? `<div class="callout callout--critical">
    <p><strong>Action needed after the update:</strong> right-click each "Needs Manual Disable" mod below in Vortex's mod list and choose <strong>Disable</strong>. This tool can't do that step for you.</p>
  </div>` : ''}

  ${badges.length > 0 ? `
  <p class="muted">Click a status below to filter the list.</p>
  <div class="summary-badges" id="compareBadges">${badges.join('')}</div>
  <div class="plan-table-wrap">
    <table class="plan-table">
      <thead><tr><th>Mod</th><th>Status</th><th>Author</th><th>Version</th><th>Category</th></tr></thead>
      <tbody id="compareTableBody">${allRows.join('')}</tbody>
    </table>
  </div>` : `<p class="table-empty-note">Nothing to report -- the collection updated cleanly, with no changes to your ignored/disabled mods.</p>`}

  ${hasIgnoredRows ? `<div class="callout callout--info">
    <p>The mods you marked Ignored were removed, so we can't tell which plugin files belonged to them.
    Don't worry about it -- Vortex will treat any leftover plugin entries as missing files, the same as anything else no longer installed.</p>
  </div>` : ''}

  ${outPath ? `<h2 class="settings-section-title">Automatically disabled for you</h2>
  ${pluginsDisabledRows.length > 0
    ? `<div class="plan-table-wrap"><table class="plan-table">
        <thead><tr><th>Plugin</th><th>For mod</th></tr></thead>
        <tbody>${pluginsDisabledRows.join('')}</tbody>
      </table></div>`
    : `<p class="table-empty-note">Nothing needed to be turned off automatically.</p>`}
  ${outPath ? `<div>Output: <code>${esc(outPath)}</code> <span class="badge ${applied ? 'badge--success' : 'badge--neutral'}">${applied ? 'WRITTEN' : 'DRY RUN'}</span></div>` : ''}` : ''}

<script>
function applyStatusFilter(status) {
  document.querySelectorAll('#compareBadges .badge').forEach(function (b) { b.classList.remove('badge--filter-active'); });
  var rows = document.querySelectorAll('#compareTableBody tr[data-status]');
  if (!status) {
    rows.forEach(function (r) { r.style.display = ''; });
    return;
  }
  var badge = document.querySelector('#compareBadges .badge--clickable[data-status="' + CSS.escape(status) + '"]');
  if (badge) badge.classList.add('badge--filter-active');
  rows.forEach(function (r) { r.style.display = r.dataset.status === status ? '' : 'none'; });
}
var badgesEl = document.getElementById('compareBadges');
if (badgesEl) {
  badgesEl.addEventListener('click', function (e) {
    var badge = e.target.closest('.badge--clickable, .badge--show-all');
    if (!badge) return;
    applyStatusFilter(badge.dataset.status || '');
  });
}
// Forces a real popup WINDOW instead of a new tab -- a plain target="_blank" anchor click is
// treated as a tab by every modern browser regardless of site preference; window.open() with
// explicit width/height window features is what actually gets browsers to open a separate window.
// Same exact pattern as web/rebuild-routes.js's log-view report -- target="_blank"/rel="noopener"
// stay on the <a> itself purely as a middle-click/ctrl-click fallback (those bypass this click
// handler entirely and use the browser's own default).
document.querySelectorAll('.mod-name-link').forEach(function (a) {
  a.addEventListener('click', function (e) {
    e.preventDefault();
    window.open(a.href, '_blank', 'noopener,width=1200,height=900');
  });
});
</script>
</body>
</html>`;
}

module.exports = { buildHtmlReport };
