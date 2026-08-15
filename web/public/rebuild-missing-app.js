'use strict';
// Rebuild Missing Files (Utilities sub-tab) -- checks one or more picked collections for staging
// files that are missing, and lets the user restore just those from the archive. Reuses $g/el from
// cleanup-app.js, same "self-contained area, shared tiny helpers" convention as this project's
// other *-app.js files. See design/vortex-rebuild-missing-files-mockup.html for the approved
// visual/interaction reference this page's markup and behavior were built from.

const rmfState = {
  configured: true,
  picked: new Set(), // collectionModId
  collectionsById: new Map(), // collectionModId -> { name, modCount, group }
  rows: [], // flattened scan report rows -- see rmfRenderReport
  selected: new Set(), // row index
  eventSource: null,
  extractEventSource: null,
};

async function rmfApi(method, urlPath, body) {
  const res = await fetch(urlPath, {
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

function rmfHandleError(e, box) {
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(() => {});
    return;
  }
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError();
    return;
  }
  box.textContent = e.message;
  box.classList.remove('hidden');
}

// ---------- Load / picker (Screen 1) ----------

let rmfPageLoaded = false;
async function loadRebuildMissingPageOnce() {
  if (rmfPageLoaded) return;
  rmfPageLoaded = true;
  await rmfLoadCollections();
}

async function rmfLoadCollections() {
  $g('rmfPickerLoading').classList.remove('hidden');
  $g('rmfNotConfigured').classList.add('hidden');
  try {
    const data = await rmfApi('GET', '/api/rebuild-missing/collections');
    $g('rmfPickerLoading').classList.add('hidden');
    rmfState.configured = data.configured;
    if (!data.configured) {
      $g('rmfNotConfigured').textContent = 'Set up your staging and downloads folders under Settings first.';
      $g('rmfNotConfigured').classList.remove('hidden');
      return;
    }
    rmfRenderPickerGroup('rmfInstalledSection', 'rmfInstalledGrid', 'rmfInstalledCount', data.installed, 'n', `${data.installed.length} found`);
    rmfRenderPickerGroup('rmfWorkshopSection', 'rmfWorkshopGrid', 'rmfWorkshopCount', data.workshop, 'w', "collections you're authoring, not installed");
    // Cached server-side, only populated once the director has clicked "Check Workshop for
    // un-fetched collections" at least once this session (queue: rebuild-missing-vortex-db-read) --
    // empty until then, same as before this feature existed.
    rmfRenderUnfetchedGroup(data.notDownloaded || []);
    // Batch "refresh before scan" toggle's own persisted state (queue: rebuild-missing-batch-
    // refresh-toggle) -- synced here so it survives a picker reload, same as the checkbox
    // selections above already implicitly do via rmfState.picked.
    $g('rmfRefreshToggle').checked = !!data.refreshWorkshopBeforeScan;
    rmfUpdateRefreshWarning();
    $g('rmfPickerEmpty').classList.toggle('hidden', data.installed.length + data.workshop.length > 0);
    if (data.installed.length + data.workshop.length === 0) {
      $g('rmfPickerEmpty').textContent = 'No collections found in your staging folder yet.';
    }
  } catch (e) {
    $g('rmfPickerLoading').classList.add('hidden');
    rmfHandleError(e, $g('rmfNotConfigured'));
  }
}

// Persists immediately on toggle -- own small route, not the Settings page's Save button, same
// pattern as Missing Masters' own recognizeEslifierInput (missing-masters-app.js).
$g('rmfRefreshToggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    await rmfApi('POST', '/api/rebuild-missing/set-refresh-workshop-before-scan', { enabled });
  } catch (err) {
    // Best-effort -- the toggle's own on-screen state is already correct either way; a failed save
    // just means it won't be remembered next visit, not worth blocking the director over.
  }
  rmfUpdateRefreshWarning();
});

// Recomputes the ONE consolidated warning (queue: rebuild-missing-batch-refresh-toggle) -- shown
// only when the toggle is on AND at least one Workshop collection is currently selected, naming
// every affected one, instead of a confirm modal per card (the v2 flow this replaces). Called
// whenever either input changes: the toggle itself, or any checkbox (via rmfRenderPickerGroup's
// own change handler).
function rmfUpdateRefreshWarning() {
  const enabled = $g('rmfRefreshToggle').checked;
  const names = [...rmfState.picked]
    .map((id) => rmfState.collectionsById.get(id))
    .filter((item) => item && item.isWorkshop)
    .map((item) => item.name);
  const show = enabled && names.length > 0;
  $g('rmfRefreshWarning').classList.toggle('hidden', !show);
  if (show) {
    // el() with a text-node child (not raw innerHTML/template strings) -- same convention every
    // other list in this file already uses, so a collection name never needs its own separate
    // HTML-escaping pass.
    const list = $g('rmfRefreshWarningList');
    list.innerHTML = '';
    names.forEach((n) => list.appendChild(el('li', {}, n)));
  }
}

$g('rmfLoadVortexDataBtn').addEventListener('click', async () => {
  const btn = $g('rmfLoadVortexDataBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  $g('rmfVortexDataError').classList.add('hidden');
  $g('rmfVortexDataStatus').textContent = '';
  try {
    const result = await rmfApi('POST', '/api/rebuild-missing/load-vortex-data', {});
    $g('rmfVortexDataStatus').textContent = result.notDownloaded.length === 0
      ? 'No un-fetched Workshop collections found.'
      : `Found ${result.notDownloaded.length} un-fetched Workshop collection${result.notDownloaded.length === 1 ? '' : 's'}.`;
    rmfRenderUnfetchedGroup(result.notDownloaded);
  } catch (e) {
    rmfHandleError(e, $g('rmfVortexDataError'));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

function rmfRenderPickerGroup(sectionId, gridId, countId, items, prefix, countText) {
  $g(sectionId).classList.toggle('hidden', items.length === 0);
  if (items.length === 0) return;
  $g(countId).textContent = countText;
  const grid = $g(gridId);
  grid.innerHTML = '';
  const isWorkshop = prefix === 'w';
  for (const item of items) {
    item.isWorkshop = isWorkshop;
    rmfState.collectionsById.set(item.modId, item);
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = rmfState.picked.has(item.modId);
    // "Last dealt with" (queue: rebuild-missing-last-fixed) -- same single inline-dash-suffix
    // convention Rebuild Collection's own picker already uses for its "Last extracted" (app.js),
    // not Workshop Report's own two-line absolute+relative format -- that fits a wide table column,
    // this is a narrow card with room for exactly one compact sub-line, so appending to the
    // existing "N mods" text keeps the established one-line rhythm instead of growing every card
    // taller. Only present once this router has actually fixed something here (extract/download) --
    // absent (not a blank/zero date) for a collection never touched, per the task's own instruction.
    const lastFixedText = item.lastFixed ? ` — Last dealt with: ${new Date(item.lastFixed).toLocaleString()}` : '';
    const subLine = el('div', { class: 'sub' }, `${item.modCount} mod${item.modCount === 1 ? '' : 's'}${lastFixedText}`);
    // The per-card "↻ Refresh from Nexus" button (v2, commit 4fedf7d) is gone -- replaced by the
    // batch toggle under the Workshop group (queue: rebuild-missing-batch-refresh-toggle, approved
    // v3 mockup addendum). Nothing here refreshes on a per-card basis anymore, Installed or Workshop.
    const card = el('label', { class: `coll-card${checkbox.checked ? ' sel' : ''}` }, [
      checkbox,
      el('div', { class: 'meta' }, [
        el('div', { class: 'name' }, item.name),
        subLine,
      ]),
    ]);
    item.subLineEl = subLine;
    checkbox.addEventListener('change', () => {
      card.classList.toggle('sel', checkbox.checked);
      if (checkbox.checked) rmfState.picked.add(item.modId);
      else rmfState.picked.delete(item.modId);
      rmfUpdatePickCount();
      rmfUpdateRefreshWarning();
    });
    grid.appendChild(card);
  }
}

// A "not yet downloaded" row (queue: rebuild-missing-vortex-db-read) -- a Workshop collection
// Vortex tracks but that has no local collection.json at all, so there's nothing to scan against.
// Deliberately a SEPARATE renderer from rmfRenderPickerGroup above, not a third mode bolted onto
// it: no checkbox (nothing to pick yet), no mod count (unknown until fetched), and a different
// action (Fetch, not Refresh) -- different enough that sharing one function risked a tangle of
// conditionals rather than two small, readable ones.
function rmfRenderUnfetchedGroup(items) {
  const section = $g('rmfUnfetchedSection');
  section.classList.toggle('hidden', items.length === 0);
  if (items.length === 0) return;
  $g('rmfUnfetchedCount').textContent = `${items.length} found`;
  const grid = $g('rmfUnfetchedGrid');
  grid.innerHTML = '';
  for (const item of items) {
    // Defensive, not hypothetical: scanAllCollections (state-query-worker.js) only sets
    // collectionSlug when Vortex itself has attributes###collectionSlug on record -- a collection
    // created/tracked purely locally, never linked to Nexus at all, genuinely can come back null.
    // Better to say so plainly here than let Fetch fail with an unexplained "missing slug" error.
    const hasSlug = !!item.collectionSlug;
    const note = el('div', { class: 'sub' }, hasSlug ? 'Not downloaded yet' : 'No Nexus id on record for this collection');
    const fetchBtn = el('button', { type: 'button', class: 'btn btn--primary btn--small rmf-refresh-btn' }, '⬇ Fetch from Nexus');
    // Set as a property, not via el()'s attrs (which uses setAttribute -- a `disabled` ATTRIBUTE is
    // present/disabled the moment it's set to ANY value, even the string "undefined", so a
    // conditional el({disabled: hasSlug ? undefined : true}) would silently always disable it).
    fetchBtn.disabled = !hasSlug;
    fetchBtn.addEventListener('click', () => rmfStartFirstFetch(item, fetchBtn));
    // A plain <div>, not a <label>+checkbox like a normal .coll-card -- there's nothing to check
    // yet, so no click-toggles-checkbox behavior to guard against either.
    const card = el('div', { class: 'coll-card coll-card--unfetched' }, [
      el('div', { class: 'meta' }, [
        el('div', { class: 'name' }, item.name),
        note,
        fetchBtn,
      ]),
    ]);
    grid.appendChild(card);
  }
}

function rmfUpdatePickCount() {
  const n = rmfState.picked.size;
  $g('rmfPickCount').innerHTML = `<b>${n}</b> collection${n === 1 ? '' : 's'} selected`;
  $g('rmfScanBtn').disabled = n === 0;
}

$g('rmfScanBtn').addEventListener('click', rmfStartScan);
$g('rmfBackToPickerBtn').addEventListener('click', () => {
  $g('rmfReportView').classList.add('hidden');
  $g('rmfPickerView').classList.remove('hidden');
});

// ---------- Scan (Screen 2) ----------

async function rmfStartScan() {
  $g('rmfPickerView').classList.add('hidden');
  $g('rmfReportView').classList.remove('hidden');
  $g('rmfResults').classList.add('hidden');
  $g('rmfScanError').classList.add('hidden');
  $g('rmfRefreshFailuresCallout').classList.add('hidden');
  $g('rmfScanLoading').classList.remove('hidden');
  $g('rmfScanLoadingText').textContent = 'Starting scan…';

  // Batch "refresh before scan" (queue: rebuild-missing-batch-refresh-toggle) -- only the SELECTED
  // Workshop collections, and only when the toggle is on; Installed ones never refresh, matching
  // rmfUpdateRefreshWarning's own filter.
  const refreshFirst = $g('rmfRefreshToggle').checked
    ? [...rmfState.picked].filter((id) => rmfState.collectionsById.get(id)?.isWorkshop)
    : [];

  try {
    await rmfApi('POST', '/api/rebuild-missing/scan', { collectionModIds: [...rmfState.picked], refreshFirst });
  } catch (e) {
    // A 409 from "a scan is already running" (e.g. another tab) is safe to just attach below --
    // but /scan can ALSO 409 for a genuinely running Vortex now that refreshFirst needs a real
    // state.v2 read, which is a real failure, not something to silently attach past.
    if (e.status !== 409 || e.body?.error === 'vortex-running') {
      $g('rmfScanLoading').classList.add('hidden');
      rmfHandleError(e, $g('rmfScanError'));
      return;
    }
  }

  if (rmfState.eventSource) rmfState.eventSource.close();
  const es = new EventSource('/api/rebuild-missing/scan/events');
  rmfState.eventSource = es;
  es.onmessage = (msg) => rmfHandleScanEvent(JSON.parse(msg.data));
}

function rmfHandleScanEvent(frame) {
  if (frame.type === 'collection-refreshing') {
    $g('rmfScanLoadingText').textContent = `${frame.name}: refreshing from Nexus…`;
  } else if (frame.type === 'mod-scanned') {
    $g('rmfScanLoadingText').textContent = `${frame.collectionName}: ${frame.index} / ${frame.total} — ${frame.modName}`;
  } else if (frame.type === 'scan-complete') {
    $g('rmfScanLoading').classList.add('hidden');
    if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
    rmfRenderReport(frame.collectionResults, frame.stats, frame.refreshFailures);
  } else if (frame.type === 'scan-error') {
    $g('rmfScanLoading').classList.add('hidden');
    if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
    rmfHandleError(new Error(frame.message || 'The scan failed.'), $g('rmfScanError'));
  }
}

function rmfRenderReport(collectionResults, stats, refreshFailures) {
  rmfState.rows = [];
  rmfState.selected = new Set();
  rmfKindFilter = null; // a fresh scan starts clean -- same reset as rmfState.selected above
  const failedCollections = collectionResults.filter((c) => c.error);
  if (failedCollections.length > 0) {
    $g('rmfScanError').textContent = `Couldn't check ${failedCollections.length} collection(s): ` +
      failedCollections.map((c) => `${c.name} (${c.error})`).join('; ');
    $g('rmfScanError').classList.remove('hidden');
  }
  // A batch refresh failing for one collection (queue: rebuild-missing-batch-refresh-toggle, scope
  // item 6) never aborts the scan -- that collection was still scanned with whatever collection.json
  // it already had on disk, so results for it below may be stale. Surfaced here, not silently
  // dropped.
  if (refreshFailures && refreshFailures.length > 0) {
    $g('rmfRefreshFailuresCallout').textContent =
      `Couldn't refresh ${refreshFailures.length} collection(s) from Nexus before scanning -- results for these are based on whatever collection.json they already had: ` +
      refreshFailures.map((f) => `${f.name} (${f.error})`).join('; ');
    $g('rmfRefreshFailuresCallout').classList.remove('hidden');
  }
  for (const c of collectionResults) {
    if (c.error) continue;
    for (const mod of c.modsWithMissing || []) {
      rmfState.rows.push({ kind: 'missing', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
    }
    for (const mod of c.modsArchiveMissing || []) {
      rmfState.rows.push({ kind: 'archive-missing', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
    }
    // A mod Ignored in Vortex (queue: rebuild-missing-ignored-mods) -- server already reclassified
    // it out of modsWithMissing/modsArchiveMissing, so stats.modsWithMissing/filesMissing below
    // never counted it either. Acknowledged tier, not a problem to fix.
    for (const mod of c.modsIgnored || []) {
      rmfState.rows.push({ kind: 'ignored', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
    }
  }

  $g('rmfResults').classList.remove('hidden');
  $g('rmfStatColls').textContent = stats.collectionsChecked;
  $g('rmfStatMods').textContent = stats.modsWithMissing;
  $g('rmfStatFiles').textContent = stats.filesMissing;

  const nothingToShow = rmfState.rows.length === 0;
  $g('rmfAllClearCallout').classList.toggle('hidden', !nothingToShow);
  $g('rmfSummaryCallout').classList.toggle('hidden', nothingToShow);
  $g('rmfSelectionBar').classList.toggle('hidden', nothingToShow);
  $g('rmfTableWrap').classList.toggle('hidden', nothingToShow);
  $g('rmfExtractResultsCallout').classList.add('hidden');
  if (!nothingToShow) {
    $g('rmfSummaryCallout').innerHTML =
      `<b>${stats.filesMissing} file${stats.filesMissing === 1 ? '' : 's'}</b> ${stats.filesMissing === 1 ? 'is' : 'are'} missing across ` +
      `<b>${stats.modsWithMissing} mod${stats.modsWithMissing === 1 ? '' : 's'}</b>. Fixing these only updates your staging folder — ` +
      `open Vortex and click <strong>Deploy Mods</strong> afterward.`;
  }
  rmfRenderRows();
}

// ---------- Filter badges (Select All/Clear Selection's own row-kind filter) ----------
// Same clickable filter-badge convention as Missing Masters' own mmSummaryBadges/mmStatusFilter
// and Stats Report's statsIssuesBadges -- copied, not reinvented (queue: rebuild-missing-filter-badges).
// Labels match this table's own already-established row copy (rmfBuildMissingCell's "Can't check
// without the archive.", the archive-missing-note's "⚠️ {reason}") rather than inventing new
// wording -- "Archive Issue" covers both an archive-missing reason it can be ("no archive found" OR
// "found one but it doesn't match"), which "Archive Missing" alone would misdescribe for the
// mismatch case.
const RMF_KIND_INFO = {
  missing: { label: 'Missing', badgeClass: 'badge--critical' },
  'archive-missing': { label: 'Archive Issue', badgeClass: 'badge--warning' },
  // Acknowledged tier (DESIGN.md's own fifth, non-severity tier -- grey, informational, not a
  // problem) -- same badgeClass token pair Missing Masters' own mm-row--soft already uses.
  ignored: { label: 'Ignored', badgeClass: 'badge--neutral' },
};

// null shows everything -- same toggle-on-click behavior as mmStatusFilter (click the active pill
// again, or "Show all", to clear).
let rmfKindFilter = null;

function rmfRenderSummaryBadges() {
  const badgesEl = $g('rmfSummaryBadges');
  badgesEl.innerHTML = '';
  if (rmfState.rows.length === 0) return; // nothing to filter when the list itself is empty
  const counts = {};
  for (const row of rmfState.rows) counts[row.kind] = (counts[row.kind] || 0) + 1;
  // Fixed order (missing first -- the category fixable right here) rather than object insertion
  // order, so pills don't reshuffle position as counts change between renders.
  for (const key of ['missing', 'archive-missing', 'ignored']) {
    if (!counts[key]) continue;
    const info = RMF_KIND_INFO[key];
    const active = rmfKindFilter === key;
    const badge = el('span', {
      class: `badge ${info.badgeClass} badge--clickable${active ? ' badge--filter-active' : ''}`,
      'data-kind': key,
    }, [el('span', { class: 'badge__count' }, String(counts[key])), ' ' + info.label]);
    badge.addEventListener('click', () => {
      rmfKindFilter = active ? null : key;
      rmfRenderRows();
    });
    badgesEl.appendChild(badge);
  }
  const showAll = el('span', { class: `badge badge--show-all${rmfKindFilter === null ? ' badge--filter-active' : ''}` }, 'Show all');
  showAll.addEventListener('click', () => {
    rmfKindFilter = null;
    rmfRenderRows();
  });
  badgesEl.appendChild(showAll);
}

function rmfRenderRows() {
  // Judgment call (flagged, not silently copied from Missing Masters): if the active filter's own
  // category count just dropped to 0 (everything in it got fixed via Extract/Download Archive),
  // reset to "Show all" here rather than leaving the user staring at an empty table with a filter
  // that no longer means anything. Missing Masters' own mmRenderMasterList doesn't do this -- it
  // just shows an empty-state message and leaves the stale filter active, which reads as "did my
  // fix not work?" rather than "you fixed all of these." Recomputed every render (not just once)
  // so counts always reflect the live row set, per this task's own scope item 5.
  if (rmfKindFilter && !rmfState.rows.some((r) => r.kind === rmfKindFilter)) {
    rmfKindFilter = null;
  }
  rmfRenderSummaryBadges();

  const tbody = $g('rmfRows');
  tbody.innerHTML = '';
  // Filtered by original index, not the filtered array's own local index -- rmfState.selected and
  // every action handler below key off the row's real position in rmfState.rows, unaffected by
  // which rows are currently visible (a hidden row keeps its selection state, same as Archive
  // Finder's own "Show selected only" toggle already does).
  const entries = rmfState.rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => !rmfKindFilter || row.kind === rmfKindFilter);
  entries.forEach(({ row, idx }) => {
    const tr = el('tr', { 'data-idx': String(idx) });
    // Acknowledged tier (DESIGN.md's own fifth, non-severity tier) -- muted grey row, same
    // background/left-edge treatment as the "selected" state below but with --neutral instead of
    // --accent (see .row--ignored in styles.css). A mod Ignored in Vortex looks like a problem at
    // a glance otherwise; this downgrades it the same way Missing Masters' own mm-row--soft does.
    if (row.kind === 'ignored') tr.classList.add('row--ignored');
    tr.classList.toggle('selected', rmfState.selected.has(idx));

    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = rmfState.selected.has(idx);
    checkbox.disabled = row.kind !== 'missing';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) rmfState.selected.add(idx);
      else rmfState.selected.delete(idx);
      tr.classList.toggle('selected', checkbox.checked);
      rmfRefreshSelectionUI();
    });
    tr.appendChild(el('td', {}, checkbox));

    const modCell = el('td', {}, [el('div', { class: 'mod' }, row.name)]);
    if (row.kind === 'archive-missing') {
      modCell.appendChild(el('div', { class: 'archive-missing-note' }, `⚠️ ${row.reason}`));
    } else if (row.kind === 'ignored') {
      modCell.appendChild(el('div', { class: 'ignored-note' }, `⚪ ${row.reason}`));
    }
    tr.appendChild(modCell);

    tr.appendChild(el('td', { class: 'coll-tag muted' }, row.collectionName));

    tr.appendChild(el('td', {}, rmfBuildMissingCell(row, idx)));

    tr.appendChild(el('td', {}, rmfBuildActionsCell(row, idx)));

    tbody.appendChild(tr);
  });
  rmfRefreshSelectionUI();
}

const RMF_FILE_LIST_TRUNCATE_AT = 6;
function rmfBuildMissingCell(row, idx) {
  if (row.kind === 'archive-missing') {
    return el('span', { class: 'muted' }, "Can't check without the archive.");
  }
  if (row.kind === 'ignored') {
    return el('span', { class: 'muted' }, 'Not checked — ignored in Vortex.');
  }
  const wrap = el('div', { class: 'detail-cell' }, [
    el('span', { class: 'status-pill status-pill--critical' }, `${row.missing.length} missing`),
  ]);
  const shown = row.missing.slice(0, RMF_FILE_LIST_TRUNCATE_AT).map((f) => f.destination);
  const rest = row.missing.slice(RMF_FILE_LIST_TRUNCATE_AT).map((f) => f.destination);
  const list = el('div', { class: 'file-list' }, shown.join(', '));
  if (rest.length > 0) {
    const extra = el('span', { class: 'file-list-extra hidden' }, `, ${rest.join(', ')}`);
    const toggle = el('a', { class: 'file-list-toggle', 'data-more': `+${rest.length} more`, 'data-less': 'Show less' }, `+${rest.length} more`);
    list.appendChild(extra);
    list.appendChild(document.createTextNode(' '));
    list.appendChild(toggle);
  }
  wrap.appendChild(list);
  return wrap;
}

function rmfBuildActionsCell(row, idx) {
  const actions = el('div', { class: 'row-actions' });
  if (row.kind === 'missing') {
    const extractBtn = el('button', { class: 'btn btn--small rmf-extract-trigger' }, 'Extract from Archive');
    extractBtn.addEventListener('click', () => rmfConfirmExtract([idx]));
    actions.appendChild(extractBtn);
    const openBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'Open Staging Folder');
    openBtn.addEventListener('click', () => rmfOpenStagingFolder(row));
    actions.appendChild(openBtn);
  } else if (row.kind === 'ignored') {
    // Acknowledged tier -- nothing to fix here, so no action buttons at all (DESIGN.md's own rule:
    // showing a "here's how to fix it" button next to a row that says "nothing to fix" reads as a
    // contradiction). Left empty rather than a placeholder note -- the mod-name cell's own
    // "⚪ {reason}" note already says why.
  } else if (row.modId != null) {
    const dlBtn = el('button', { class: 'btn btn--small' }, 'Download Archive');
    dlBtn.addEventListener('click', () => rmfDownloadArchive(row, idx, dlBtn));
    actions.appendChild(dlBtn);
  } else {
    actions.appendChild(el('span', { class: 'muted', style: 'font-size:12px' }, 'Not on Nexus — download manually'));
  }
  return actions;
}

// Expand/collapse "+N more" -- same toggle behavior as the log-view page's own .file-list-toggle
// (rebuild-routes.js), reimplemented here since that page is a separate server-rendered document.
$g('rmfRows').addEventListener('click', (e) => {
  const toggle = e.target.closest('.file-list-toggle');
  if (!toggle) return;
  const extra = toggle.previousElementSibling;
  const stillHidden = extra.classList.toggle('hidden');
  toggle.textContent = stillHidden ? toggle.dataset.more : toggle.dataset.less;
});

// ---------- Selection bar ----------

function rmfRefreshSelectionUI() {
  const selectableCount = rmfState.rows.filter((r) => r.kind === 'missing').length;
  const n = rmfState.selected.size;
  $g('rmfSelCount').textContent = `${n} of ${selectableCount} selected`;
  $g('rmfExtractSelectedBtn').disabled = n === 0;
}

$g('rmfSelectAllBtn').addEventListener('click', () => {
  rmfState.rows.forEach((r, idx) => { if (r.kind === 'missing') rmfState.selected.add(idx); });
  rmfRenderRows();
});
$g('rmfClearBtn').addEventListener('click', () => {
  rmfState.selected.clear();
  rmfRenderRows();
});
$g('rmfInvertBtn').addEventListener('click', () => {
  rmfState.rows.forEach((r, idx) => {
    if (r.kind !== 'missing') return;
    if (rmfState.selected.has(idx)) rmfState.selected.delete(idx);
    else rmfState.selected.add(idx);
  });
  rmfRenderRows();
});
$g('rmfExtractSelectedBtn').addEventListener('click', () => rmfConfirmExtract([...rmfState.selected]));

// ---------- Extract (writes to the staging folder -- confirm modal, serious register) ----------

let rmfPendingExtractIndices = [];
function rmfConfirmExtract(indices) {
  if (indices.length === 0) return;
  rmfPendingExtractIndices = indices;
  const fileCount = indices.reduce((n, i) => n + rmfState.rows[i].missing.length, 0);
  $g('rmfExtractConfirmModalText').textContent =
    `This restores ${fileCount} missing file${fileCount === 1 ? '' : 's'} across ${indices.length} mod${indices.length === 1 ? '' : 's'} ` +
    `by extracting them straight from each mod's saved archive. It only adds back what's missing — nothing else in your staging folder is touched.`;
  $g('rmfExtractConfirmModal').classList.remove('hidden');
}
$g('rmfExtractConfirmCancelBtn').addEventListener('click', () => {
  $g('rmfExtractConfirmModal').classList.add('hidden');
});

// A big batch (a whole collection's worth of mods) can take a while -- streams per-mod progress the
// same POST-starts-202/GET-.../events-subscribes way the scan itself already does (rmfStartScan /
// rmfHandleScanEvent above), so a long-running extract never reads as "nothing is happening."
function rmfSetExtractingUI(active) {
  $g('rmfExtractLoading').classList.toggle('hidden', !active);
  document.querySelectorAll('.rmf-extract-trigger').forEach((btn) => { btn.disabled = active; });
  // rmfExtractSelectedBtn's real disabled state depends on selection count, not just "not
  // extracting" -- rmfRefreshSelectionUI is the single source of truth for that, so let it settle
  // the bulk button back to correct rather than force it enabled here.
  if (!active) rmfRefreshSelectionUI();
}

$g('rmfExtractConfirmOkBtn').addEventListener('click', async () => {
  $g('rmfExtractConfirmModal').classList.add('hidden');
  const indices = rmfPendingExtractIndices;
  const items = indices.map((i) => {
    const row = rmfState.rows[i];
    // collectionModId (queue: rebuild-missing-last-fixed) -- lets the server mark the right
    // collection(s) "dealt with" once at least one file in this batch is actually extracted.
    return { name: row.name, targetFolderName: row.targetFolderName, archivePath: row.archivePath, files: row.missing, collectionModId: row.collectionModId };
  });
  $g('rmfExtractResultsCallout').classList.add('hidden');
  rmfSetExtractingUI(true);
  $g('rmfExtractLoadingText').textContent = 'Restoring files…';
  try {
    await rmfApi('POST', '/api/rebuild-missing/extract', { items });
  } catch (e) {
    rmfSetExtractingUI(false);
    rmfHandleError(e, $g('rmfScanError'));
    return;
  }
  if (rmfState.extractEventSource) rmfState.extractEventSource.close();
  const es = new EventSource('/api/rebuild-missing/extract/events');
  rmfState.extractEventSource = es;
  es.onmessage = (msg) => rmfHandleExtractEvent(JSON.parse(msg.data), indices);
});

function rmfHandleExtractEvent(frame, indices) {
  if (frame.type === 'mod-extracted') {
    $g('rmfExtractLoadingText').textContent = `${frame.index} / ${frame.total} mods restored — ${frame.name}`;
  } else if (frame.type === 'extract-complete') {
    rmfSetExtractingUI(false);
    if (rmfState.extractEventSource) { rmfState.extractEventSource.close(); rmfState.extractEventSource = null; }
    rmfApplyExtractResults(indices, frame.results);
  } else if (frame.type === 'extract-error') {
    rmfSetExtractingUI(false);
    if (rmfState.extractEventSource) { rmfState.extractEventSource.close(); rmfState.extractEventSource = null; }
    rmfHandleError(new Error(frame.message || 'The extraction failed.'), $g('rmfScanError'));
  }
}

function rmfApplyExtractResults(indices, results) {
  let restoredFiles = 0;
  let restoredMods = 0;
  const failures = [];
  indices.forEach((idx, i) => {
    const result = results[i];
    const row = rmfState.rows[idx];
    if (!result) return;
    if (result.ok) {
      restoredFiles += (result.extracted || []).length;
      restoredMods += 1;
      row.missing = row.missing.filter((f) => !(result.extracted || []).includes(f.destination));
      rmfState.selected.delete(idx);
    } else {
      failures.push(`${row.name}: ${result.error}`);
    }
  });
  // Rows with nothing left missing drop out of the report entirely -- rebuild the row list rather
  // than just re-rendering in place, since indices shift once any row is removed.
  rmfState.rows = rmfState.rows.filter((r) => r.kind !== 'missing' || r.missing.length > 0);
  rmfState.selected = new Set();

  const callout = $g('rmfExtractResultsCallout');
  if (failures.length === 0) {
    callout.className = 'callout callout--success';
    callout.textContent = `Restored ${restoredFiles} file${restoredFiles === 1 ? '' : 's'} across ${restoredMods} mod${restoredMods === 1 ? '' : 's'}. Open Vortex and click Deploy Mods to finish.`;
  } else {
    callout.className = 'callout callout--warning';
    callout.textContent = `Restored ${restoredFiles} file(s), but ${failures.length} mod(s) had a problem: ${failures.join('; ')}`;
  }
  callout.classList.remove('hidden');
  rmfRenderRows();

  const statFiles = Math.max(0, Number($g('rmfStatFiles').textContent) - restoredFiles);
  const statMods = rmfState.rows.filter((r) => r.kind === 'missing').length;
  $g('rmfStatFiles').textContent = statFiles;
  $g('rmfStatMods').textContent = statMods;
  const nothingToShow = rmfState.rows.length === 0;
  $g('rmfAllClearCallout').classList.toggle('hidden', !nothingToShow);
  $g('rmfSummaryCallout').classList.toggle('hidden', nothingToShow);
  $g('rmfSelectionBar').classList.toggle('hidden', nothingToShow);
  $g('rmfTableWrap').classList.toggle('hidden', nothingToShow);
}

// ---------- Download Archive (archive-missing rows) ----------

async function rmfDownloadArchive(row, idx, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Downloading…';
  try {
    const { result } = await rmfApi('POST', '/api/rebuild-missing/download-archive', {
      collectionModId: row.collectionModId, modId: row.modId, fileId: row.fileId,
    });
    if (result.bucket === 'missing') {
      rmfState.rows[idx] = { kind: 'missing', collectionModId: row.collectionModId, collectionName: row.collectionName, ...result };
    } else if (result.bucket === 'ok') {
      rmfState.rows = rmfState.rows.filter((_, i) => i !== idx);
    } else {
      rmfState.rows[idx] = { kind: 'archive-missing', collectionModId: row.collectionModId, collectionName: row.collectionName, ...result };
    }
    rmfState.selected = new Set([...rmfState.selected].map((i) => (i === idx ? null : i)).filter((i) => i !== null));
    rmfRenderRows();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(e, $g('rmfScanError'));
  }
}

// ---------- Open Staging Folder ----------

async function rmfOpenStagingFolder(row) {
  try {
    await rmfApi('POST', '/api/rebuild-missing/open-staging-folder', { targetFolderName: row.targetFolderName });
  } catch (e) {
    rmfHandleError(e, $g('rmfScanError'));
  }
}

// ---------- Fetch from Nexus (Screen 1 -- "not yet downloaded" rows only) ----------
// The v2 per-card "Refresh from Nexus" button/confirm-modal (commit 4fedf7d) is gone -- replaced by
// the batch toggle above (queue: rebuild-missing-batch-refresh-toggle, approved v3 mockup addendum).
// This one action survives, simplified to match: a "not yet downloaded" row still can't join the
// batch toggle (nothing on disk yet to select/scan), so it keeps its own explicit one-time Fetch
// action -- but per the director's own explicit call ("no case for going back to an older
// revision"), it's no longer a confirm-modal + revision picker either: always the newest saved
// revision, same as the batch toggle, no picker anywhere in this tool anymore.
async function rmfStartFirstFetch(item, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  $g('rmfRefreshError').classList.add('hidden');
  $g('rmfRefreshResult').classList.add('hidden');
  try {
    const result = await rmfApi('POST', '/api/rebuild-missing/refresh-from-nexus', {
      collectionModId: item.folder, slug: item.collectionSlug,
    });
    $g('rmfRefreshResult').textContent =
      `Fetched "${item.name}" from Nexus (revision ${result.revisionNumber}) — ${result.modCount} mod${result.modCount === 1 ? '' : 's'}. ` +
      `It now shows up under "Workshop collections" above, ready to scan.`;
    $g('rmfRefreshResult').classList.remove('hidden');
    // The server already dropped this from "not yet downloaded" (a real collection.json exists
    // now); a full reload picks that up plus the new "Workshop collections" card via the plain
    // filesystem scan, same one every other row already goes through.
    await rmfLoadCollections();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(e, $g('rmfRefreshError'));
  }
}
