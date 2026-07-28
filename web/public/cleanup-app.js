'use strict';
// Clean Up (Utilities area) -- finds staging folders / downloaded archives Vortex has no real
// relationship with, lets the user review and delete them, then offers a cross-check of the OTHER
// location for exact-name matches. Own tiny helpers, same "self-contained area" convention already
// used by reports-rulesgen-app.js. Moved out of Reports into its own top-level "Utilities" nav area
// 2026-07-27 (first utility of what's meant to be a home for standalone maintenance tools, per this
// project's own pre-existing "New Utilities section" TODO) -- Clean Up *does things* (delete/
// exclude), unlike everything actually left under Reports, which is read-only.
//
// No backup/quarantine step before delete -- confirmed with the user: these are Vortex-recoverable
// (re-download from Nexus, or re-extract via Rebuild Collection), and if something actually still
// mattered, Vortex itself would flag the affected collection as incomplete. A clear confirmation
// dialog before every delete is still required, and that part is never skipped.
//
// "Select all" checkboxes: removed 2026-07-27 as redundant with the "All" action buttons, then put
// BACK the same day once the user actually tried using a large list -- select-all-then-uncheck-a-
// few is a real, faster pattern than checking 20 boxes individually when you want most-but-not-all
// of a long list. Keep both: "All" buttons for the common all-or-nothing case, select-all + individual
// unchecking for "everything except these few."

function $g(id) { return document.getElementById(id); }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function cleanupApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function cleanupHandleError(e) {
  $g('cleanupLoading').classList.add('hidden');
  // Same convention as reports-rulesgen-app.js's rgReportHandleError -- Vortex running is a normal
  // precondition, not an error, so it always gets the shared warning-styled popup.
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(() => {});
    return;
  }
  const box = $g('cleanupCriticalError');
  box.textContent = e.message;
  box.classList.remove('hidden');
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

// kind: 'staging' | 'archives'. Kept as page-level state so Delete Selected/Delete All (and the
// cross-check follow-up they trigger) know what's currently on screen without re-fetching.
let cleanupLastKind = null;
let cleanupLastExceptions = [];
let cleanupLastNeedsReview = [];

function renderResultRow(kind, item, checkClass) {
  const checkbox = el('input', { type: 'checkbox', class: checkClass, 'data-name': item.name });
  const detail = kind === 'archives' && item.sizeBytes != null ? ` -- ${formatBytes(item.sizeBytes)}` : '';
  // needsReview-only: a name matching Vortex's OTHER (space-separated) download-naming shape --
  // typically a file downloaded manually/moved straight into the folder instead of through
  // Vortex's own download manager (confirmed real 2026-07-27), not a hand-named tool-output
  // folder like the rest of this list. Still needs the same review -- just a clearer reason why.
  const hint = item.hint === 'possible-manual-download' ? el('em', { class: 'muted' }, ' -- Possible manual download?') : null;
  const label = el('label', {}, [checkbox, ' ', el('strong', {}, item.name), detail, hint]);
  return el('li', {}, [label]);
}

function updateDeleteSelectedEnabled() {
  const anyChecked = !!document.querySelector('#cleanupResultsList .cleanup-row-check:checked');
  $g('cleanupDeleteSelectedBtn').disabled = !anyChecked;
}

function updateNeedsReviewButtonsEnabled() {
  const anyChecked = !!document.querySelector('#cleanupNeedsReviewList .cleanup-review-check:checked');
  $g('cleanupNeedsReviewDeleteCheckedBtn').disabled = !anyChecked;
  $g('cleanupNeedsReviewExcludeCheckedBtn').disabled = !anyChecked;
}

// Archives-only, informational pointer -- NOT a list/delete UI (see cleanup-scan.js's scanArchives
// header comment for why: Vortex's own Mods table groups/absorbs multiple download-versions of the
// same mod in ways not worth reproducing exactly here). Just tells the user Vortex's own Status
// filter has something worth reviewing.
function renderUninstalledNotice(kind, hasUninstalledArchives) {
  $g('cleanupUninstalledNotice').classList.toggle('hidden', kind !== 'archives' || !hasUninstalledArchives);
}

function renderNeedsReview(kind, needsReview) {
  cleanupLastNeedsReview = needsReview;
  if (needsReview.length === 0) {
    $g('cleanupNeedsReview').classList.add('hidden');
    return;
  }
  const nounSingular = kind === 'archives' ? 'archive' : 'folder';
  const nounPlural = kind === 'archives' ? 'Archives' : 'Folders';
  $g('cleanupNeedsReviewTitle').textContent = `⚠️ Action Needed: Unrecognized ${nounPlural} Found`;
  $g('cleanupNeedsReviewMeta').textContent =
    `We found the following ${nounSingular}s, but their names don't match the usual format. Please double-check them to let us know if they should be excluded or if they're safe to delete.`;

  const list = $g('cleanupNeedsReviewList');
  list.innerHTML = '';
  for (const item of needsReview) list.appendChild(renderResultRow(kind, item, 'cleanup-review-check'));

  $g('cleanupNeedsReviewSelectAllInput').checked = false;
  updateNeedsReviewButtonsEnabled();
  $g('cleanupNeedsReview').classList.remove('hidden');
}

function renderResults(kind, data) {
  cleanupLastKind = kind;
  cleanupLastExceptions = data.exceptions;
  $g('cleanupLoading').classList.add('hidden');
  $g('cleanupCriticalError').classList.add('hidden');
  $g('cleanupNotConfigured').classList.add('hidden');

  if (!data.configured) {
    const label = kind === 'archives' ? 'your downloads folder' : 'your staging folder';
    $g('cleanupNotConfigured').textContent = `Set up ${label} under Settings first.`;
    $g('cleanupNotConfigured').classList.remove('hidden');
    $g('cleanupResults').classList.add('hidden');
    $g('cleanupNeedsReview').classList.add('hidden');
    $g('cleanupUninstalledNotice').classList.add('hidden');
    $g('cleanupEmpty').classList.add('hidden');
    return;
  }

  renderNeedsReview(kind, data.needsReview || []);
  renderUninstalledNotice(kind, data.hasUninstalledArchives);

  if (data.exceptions.length === 0) {
    $g('cleanupResults').classList.add('hidden');
    const label = kind === 'archives' ? 'archives' : 'staging folders';
    $g('cleanupEmpty').textContent = `No unrelated ${label} found -- everything checked (${data.total}) has a real match in Vortex.`;
    $g('cleanupEmpty').classList.remove('hidden');
    return;
  }

  $g('cleanupEmpty').classList.add('hidden');
  const label = kind === 'archives' ? 'archive(s)' : 'staging folder(s)';
  $g('cleanupResultsTitle').textContent = kind === 'archives' ? 'Archive exceptions' : 'Staging folder exceptions';
  $g('cleanupResultsMeta').textContent =
    `${data.exceptions.length} of ${data.total} ${label} have no relationship with a downloaded mod or collection.`;

  const list = $g('cleanupResultsList');
  list.innerHTML = '';
  for (const item of data.exceptions) list.appendChild(renderResultRow(kind, item, 'cleanup-row-check'));

  $g('cleanupSelectAllInput').checked = false;
  updateDeleteSelectedEnabled();
  $g('cleanupResults').classList.remove('hidden');
}

async function runScan(kind) {
  $g('cleanupCriticalError').classList.add('hidden');
  $g('cleanupNotConfigured').classList.add('hidden');
  $g('cleanupEmpty').classList.add('hidden');
  $g('cleanupResults').classList.add('hidden');
  $g('cleanupUninstalledNotice').classList.add('hidden');
  $g('cleanupLoading').classList.remove('hidden');
  $g('cleanupScanArchivesBtn').classList.toggle('btn--primary', kind === 'archives');
  $g('cleanupScanArchivesBtn').classList.toggle('btn--ghost', kind !== 'archives');
  $g('cleanupScanStagingBtn').classList.toggle('btn--primary', kind === 'staging');
  $g('cleanupScanStagingBtn').classList.toggle('btn--ghost', kind !== 'staging');
  try {
    const data = await cleanupApi('GET', kind === 'archives' ? '/api/cleanup/scan-archives' : '/api/cleanup/scan-staging');
    renderResults(kind, data);
  } catch (e) {
    cleanupHandleError(e);
  }
}

$g('cleanupScanArchivesBtn').addEventListener('click', () => runScan('archives'));
$g('cleanupScanStagingBtn').addEventListener('click', () => runScan('staging'));

$g('cleanupSelectAllInput').addEventListener('change', (ev) => {
  document.querySelectorAll('#cleanupResultsList .cleanup-row-check').forEach((cb) => { cb.checked = ev.target.checked; });
  updateDeleteSelectedEnabled();
});
$g('cleanupResultsList').addEventListener('change', (ev) => {
  if (ev.target.classList.contains('cleanup-row-check')) updateDeleteSelectedEnabled();
});

$g('cleanupNeedsReviewSelectAllInput').addEventListener('change', (ev) => {
  document.querySelectorAll('#cleanupNeedsReviewList .cleanup-review-check').forEach((cb) => { cb.checked = ev.target.checked; });
  updateNeedsReviewButtonsEnabled();
});
$g('cleanupNeedsReviewList').addEventListener('change', (ev) => {
  if (ev.target.classList.contains('cleanup-review-check')) updateNeedsReviewButtonsEnabled();
});

// ---------- Action Needed: Unrecognized (needsReview) -- Delete/Exclude, Checked/All ----------
// One shared confirm modal for all four actions -- bottom line per the user: if in doubt, always
// ask, never silently assume either delete or keep. `cleanupReviewPendingAction` is either 'delete'
// or 'exclude'; the OK handler branches on it after confirmation.

let cleanupReviewPendingNames = [];
let cleanupReviewPendingAction = null;

function showCleanupReviewConfirmModal(action, names) {
  if (names.length === 0) return;
  cleanupReviewPendingAction = action;
  cleanupReviewPendingNames = names;
  const kind = cleanupLastKind;
  const noun = kind === 'archives' ? 'archive' : 'staging folder';
  const plural = names.length === 1 ? '' : 's';
  if (action === 'delete') {
    $g('cleanupReviewConfirmModalTitle').textContent = 'Delete these permanently?';
    $g('cleanupReviewConfirmModalText').textContent =
      `This will permanently delete ${names.length} ${noun}${plural}. This can't be undone.`;
    $g('cleanupReviewConfirmOkBtn').textContent = 'Delete';
  } else {
    $g('cleanupReviewConfirmModalTitle').textContent = 'Exclude from future scans?';
    $g('cleanupReviewConfirmModalText').textContent =
      `This will mark ${names.length} ${noun}${plural} as known-safe -- they won't be shown again ` +
      `unless you remove them from the exclude list under Settings.`;
    $g('cleanupReviewConfirmOkBtn').textContent = 'Exclude';
  }
  $g('cleanupReviewConfirmModal').classList.remove('hidden');
}

function checkedNeedsReviewNames() {
  return [...document.querySelectorAll('#cleanupNeedsReviewList .cleanup-review-check:checked')].map((cb) => cb.dataset.name);
}

$g('cleanupNeedsReviewDeleteCheckedBtn').addEventListener('click', () => showCleanupReviewConfirmModal('delete', checkedNeedsReviewNames()));
$g('cleanupNeedsReviewDeleteAllBtn').addEventListener('click', () => showCleanupReviewConfirmModal('delete', cleanupLastNeedsReview.map((e) => e.name)));
$g('cleanupNeedsReviewExcludeCheckedBtn').addEventListener('click', () => showCleanupReviewConfirmModal('exclude', checkedNeedsReviewNames()));
$g('cleanupNeedsReviewExcludeAllBtn').addEventListener('click', () => showCleanupReviewConfirmModal('exclude', cleanupLastNeedsReview.map((e) => e.name)));

$g('cleanupReviewConfirmCancelBtn').addEventListener('click', () => {
  $g('cleanupReviewConfirmModal').classList.add('hidden');
});
$g('cleanupReviewConfirmOkBtn').addEventListener('click', async () => {
  $g('cleanupReviewConfirmModal').classList.add('hidden');
  const kind = cleanupLastKind;
  const names = cleanupReviewPendingNames;
  try {
    if (cleanupReviewPendingAction === 'delete') {
      await cleanupApi('POST', '/api/cleanup/delete', { kind, names });
      await runScan(kind);
      await runCrossCheckFollowUp(kind, names);
    } else {
      await cleanupApi('POST', '/api/cleanup/exclude', { kind, names });
      await runScan(kind); // excluded names disappear from needsReview on the next scan
    }
  } catch (e) {
    cleanupHandleError(e);
  }
});

// ---------- Delete Selected / Delete All (primary scan results) ----------

let cleanupPendingDeleteNames = [];

function showCleanupDeleteConfirmModal(names) {
  cleanupPendingDeleteNames = names;
  const label = cleanupLastKind === 'archives' ? 'archive' : 'staging folder';
  $g('cleanupDeleteConfirmModalText').textContent =
    `This will permanently delete ${names.length} ${label}${names.length === 1 ? '' : 's'}. This can't be undone.`;
  $g('cleanupDeleteConfirmModal').classList.remove('hidden');
}
$g('cleanupDeleteSelectedBtn').addEventListener('click', () => {
  const names = [...document.querySelectorAll('#cleanupResultsList .cleanup-row-check:checked')].map((cb) => cb.dataset.name);
  if (names.length > 0) showCleanupDeleteConfirmModal(names);
});
$g('cleanupDeleteAllBtn').addEventListener('click', () => {
  showCleanupDeleteConfirmModal(cleanupLastExceptions.map((e) => e.name));
});
$g('cleanupDeleteConfirmCancelBtn').addEventListener('click', () => {
  $g('cleanupDeleteConfirmModal').classList.add('hidden');
});
$g('cleanupDeleteConfirmOkBtn').addEventListener('click', async () => {
  $g('cleanupDeleteConfirmModal').classList.add('hidden');
  const kind = cleanupLastKind;
  const names = cleanupPendingDeleteNames;
  try {
    await cleanupApi('POST', '/api/cleanup/delete', { kind, names });
    await runScan(kind); // refresh the list -- deleted rows disappear, any failures would still show
    await runCrossCheckFollowUp(kind, names);
  } catch (e) {
    cleanupHandleError(e);
  }
});

// ---------- Cross-check follow-up ----------

let cleanupCrossCheckKind = null; // the OTHER side -- what the follow-up modal would delete
let cleanupCrossCheckMatches = [];

async function runCrossCheckFollowUp(deletedKind, deletedNames) {
  let matches;
  try {
    ({ matches } = await cleanupApi('POST', '/api/cleanup/cross-check', { kind: deletedKind, names: deletedNames }));
  } catch {
    return; // best-effort -- the primary delete already succeeded, don't let this fail loudly
  }
  if (!matches || matches.length === 0) return;

  cleanupCrossCheckKind = deletedKind === 'archives' ? 'staging' : 'archives';
  cleanupCrossCheckMatches = matches;
  const otherLabel = cleanupCrossCheckKind === 'archives' ? 'archive(s) in the downloads folder' : 'staging folder(s)';
  $g('cleanupCrossCheckModalTitle').textContent = `Found ${matches.length} matching ${otherLabel}`;
  $g('cleanupCrossCheckModalMeta').textContent =
    'These share the exact same name as what you just deleted -- delete these too?';

  const list = $g('cleanupCrossCheckList');
  list.innerHTML = '';
  for (const item of matches) {
    const checkbox = el('input', { type: 'checkbox', class: 'cleanup-xcheck-row', 'data-name': item.name, checked: 'checked' });
    list.appendChild(el('li', {}, [el('label', {}, [checkbox, ' ', el('strong', {}, item.name)])]));
  }
  $g('cleanupCrossCheckSelectAllInput').checked = true;
  $g('cleanupCrossCheckModal').classList.remove('hidden');
}

$g('cleanupCrossCheckSelectAllInput').addEventListener('change', (ev) => {
  document.querySelectorAll('#cleanupCrossCheckList .cleanup-xcheck-row').forEach((cb) => { cb.checked = ev.target.checked; });
});
$g('cleanupCrossCheckSkipBtn').addEventListener('click', () => {
  $g('cleanupCrossCheckModal').classList.add('hidden');
});
async function deleteCrossCheckMatches(names) {
  if (names.length === 0) return;
  try {
    await cleanupApi('POST', '/api/cleanup/delete', { kind: cleanupCrossCheckKind, names });
  } catch (e) {
    cleanupHandleError(e);
  } finally {
    $g('cleanupCrossCheckModal').classList.add('hidden');
    // If the report currently on screen is the side we just cross-deleted from, refresh it too.
    if (cleanupLastKind === cleanupCrossCheckKind) await runScan(cleanupLastKind);
  }
}
$g('cleanupCrossCheckDeleteSelectedBtn').addEventListener('click', () => {
  const names = [...document.querySelectorAll('#cleanupCrossCheckList .cleanup-xcheck-row:checked')].map((cb) => cb.dataset.name);
  deleteCrossCheckMatches(names);
});
$g('cleanupCrossCheckDeleteAllBtn').addEventListener('click', () => {
  deleteCrossCheckMatches(cleanupCrossCheckMatches.map((m) => m.name));
});

// Utilities area sub-tabs (Missing Masters / Vortex Scrub) -- mirrors stats-app.js's own
// showReportsSubTab exactly (same array-of-ids toggle pattern). Missing Masters listed/defaulted
// first -- confirmed 2026-07-27 it's used far more often than Vortex Scrub. "Missing Masters" itself
// has no load-once gate here (unlike Reports' loadStatsPageOnce/loadWorkThroughPageOnce) -- it needs
// to scan every time the tab is shown (and on focus/visibility change), not just once ever, so
// missing-masters-app.js manages its own refresh timing; this just calls its exposed hook via the
// same "deliberate seam" pattern reports-rulesgen-app.js already uses (a plain `typeof === function`
// check, since missing-masters-app.js loads after this file and can't be referenced directly here).
const UTILITIES_SUB_TABS = ['missingmasters', 'scrub', 'archivefinder'];
function showUtilitiesSubTab(id) {
  for (const tab of UTILITIES_SUB_TABS) {
    $g(`utilities-sub-area-${tab}`).classList.toggle('hidden', tab !== id);
    $g(`utilities-sub-${tab}`).classList.toggle('btn--primary', tab === id);
    $g(`utilities-sub-${tab}`).classList.toggle('btn--ghost', tab !== id);
  }
  if (id === 'missingmasters' && typeof runMissingMastersScan === 'function') runMissingMastersScan();
  // Same "deliberate seam" pattern as missing-masters-app.js above -- loads config/stats once per
  // visit to this tab (archive-finder-app.js loads after this file).
  if (id === 'archivefinder' && typeof loadArchiveFinderPageOnce === 'function') loadArchiveFinderPageOnce();

  // Keeps the URL in sync so a browser refresh returns to this exact sub-tab, not just the
  // Utilities area generically -- same fix as showReportsSubTab (stats-app.js) / showToolArea
  // (shell.js) for the same underlying gap: clicking a nav/sub-tab never used to touch the URL.
  const url = new URL(location.href);
  url.searchParams.set('area', 'utilities');
  url.searchParams.set('utilities', id);
  history.replaceState(null, '', url);
}
for (const tab of UTILITIES_SUB_TABS) {
  $g(`utilities-sub-${tab}`).addEventListener('click', () => showUtilitiesSubTab(tab));
}
// Home replaced the old nav-utilities tab this used to hang off of -- every Home card for a
// Utilities sub-tool already passes its own explicit sub-tab id (see shell.js's navigateToArea),
// so there's no longer a generic "Utilities" entry point that needs a default-to-missingmasters
// fallback.
