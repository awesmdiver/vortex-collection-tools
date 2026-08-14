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
    $g('rmfPickerEmpty').classList.toggle('hidden', data.installed.length + data.workshop.length > 0);
    if (data.installed.length + data.workshop.length === 0) {
      $g('rmfPickerEmpty').textContent = 'No collections found in your staging folder yet.';
    }
  } catch (e) {
    $g('rmfPickerLoading').classList.add('hidden');
    rmfHandleError(e, $g('rmfNotConfigured'));
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
    const subLine = el('div', { class: 'sub' }, `${item.modCount} mod${item.modCount === 1 ? '' : 's'}`);
    // type="button" (never submits) + preventDefault/stopPropagation in the click handler below --
    // this button sits inside the card's own <label>, whose default click behavior is to toggle the
    // checkbox, which we don't want to fire when the user meant to click this instead.
    const refreshBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--small rmf-refresh-btn' }, '↻ Refresh from Nexus');
    refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rmfStartRefresh(item, refreshBtn);
    });
    const card = el('label', { class: `coll-card${checkbox.checked ? ' sel' : ''}` }, [
      checkbox,
      el('div', { class: 'meta' }, [
        el('div', { class: 'name' }, item.name),
        subLine,
        refreshBtn,
      ]),
    ]);
    item.subLineEl = subLine;
    checkbox.addEventListener('change', () => {
      card.classList.toggle('sel', checkbox.checked);
      if (checkbox.checked) rmfState.picked.add(item.modId);
      else rmfState.picked.delete(item.modId);
      rmfUpdatePickCount();
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
  $g('rmfScanLoading').classList.remove('hidden');
  $g('rmfScanLoadingText').textContent = 'Starting scan…';

  try {
    await rmfApi('POST', '/api/rebuild-missing/scan', { collectionModIds: [...rmfState.picked] });
  } catch (e) {
    if (e.status !== 409) {
      $g('rmfScanLoading').classList.add('hidden');
      rmfHandleError(e, $g('rmfScanError'));
      return;
    }
    // A 409 just means a scan is already running (e.g. another tab) -- still attach below.
  }

  if (rmfState.eventSource) rmfState.eventSource.close();
  const es = new EventSource('/api/rebuild-missing/scan/events');
  rmfState.eventSource = es;
  es.onmessage = (msg) => rmfHandleScanEvent(JSON.parse(msg.data));
}

function rmfHandleScanEvent(frame) {
  if (frame.type === 'mod-scanned') {
    $g('rmfScanLoadingText').textContent = `${frame.collectionName}: ${frame.index} / ${frame.total} — ${frame.modName}`;
  } else if (frame.type === 'scan-complete') {
    $g('rmfScanLoading').classList.add('hidden');
    if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
    rmfRenderReport(frame.collectionResults, frame.stats);
  } else if (frame.type === 'scan-error') {
    $g('rmfScanLoading').classList.add('hidden');
    if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
    rmfHandleError(new Error(frame.message || 'The scan failed.'), $g('rmfScanError'));
  }
}

function rmfRenderReport(collectionResults, stats) {
  rmfState.rows = [];
  rmfState.selected = new Set();
  const failedCollections = collectionResults.filter((c) => c.error);
  if (failedCollections.length > 0) {
    $g('rmfScanError').textContent = `Couldn't check ${failedCollections.length} collection(s): ` +
      failedCollections.map((c) => `${c.name} (${c.error})`).join('; ');
    $g('rmfScanError').classList.remove('hidden');
  }
  for (const c of collectionResults) {
    if (c.error) continue;
    for (const mod of c.modsWithMissing || []) {
      rmfState.rows.push({ kind: 'missing', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
    }
    for (const mod of c.modsArchiveMissing || []) {
      rmfState.rows.push({ kind: 'archive-missing', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
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

function rmfRenderRows() {
  const tbody = $g('rmfRows');
  tbody.innerHTML = '';
  rmfState.rows.forEach((row, idx) => {
    const tr = el('tr', { 'data-idx': String(idx) });
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
    const extractBtn = el('button', { class: 'btn btn--small' }, 'Extract from Archive');
    extractBtn.addEventListener('click', () => rmfConfirmExtract([idx]));
    actions.appendChild(extractBtn);
    const openBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'Open Staging Folder');
    openBtn.addEventListener('click', () => rmfOpenStagingFolder(row));
    actions.appendChild(openBtn);
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
$g('rmfExtractConfirmOkBtn').addEventListener('click', async () => {
  $g('rmfExtractConfirmModal').classList.add('hidden');
  const indices = rmfPendingExtractIndices;
  const items = indices.map((i) => {
    const row = rmfState.rows[i];
    return { name: row.name, targetFolderName: row.targetFolderName, archivePath: row.archivePath, files: row.missing };
  });
  try {
    const { results } = await rmfApi('POST', '/api/rebuild-missing/extract', { items });
    rmfApplyExtractResults(indices, results);
  } catch (e) {
    rmfHandleError(e, $g('rmfScanError'));
  }
});

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

// ---------- Refresh from Nexus (Screen 1 -- overwrites collection.json, confirm modal, serious register) ----------
// A stale local collection.json (never updated to match what's actually published on Nexus) is a
// real cause of false "archive mismatch" results further down the line in this same tool -- it
// diffs against whatever collection.json SAYS should be installed, so a stale copy makes correctly-
// installed mods look broken. This pulls a fresh copy straight from Nexus, same download path
// Rebuild Collection's own Workshop "Fetch from Nexus" button already uses.

let rmfPendingRefresh = null;

async function rmfStartRefresh(item, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Looking up…';
  $g('rmfRefreshError').classList.add('hidden');
  $g('rmfRefreshResult').classList.add('hidden');
  let slugInfo;
  try {
    slugInfo = await rmfApi('POST', '/api/rebuild-missing/nexus-slug', { collectionModId: item.modId });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(e, $g('rmfRefreshError'));
    return;
  }
  btn.disabled = false;
  btn.textContent = original;
  rmfPendingRefresh = { item, slug: slugInfo.slug, collectionModId: item.modId, isFirstFetch: false };
  $g('rmfRefreshConfirmModalText').textContent =
    `This replaces the local collection.json for "${item.name}" with the revision you pick below. ` +
    `The current file is backed up first, right next to it, so you can always undo this.`;
  $g('rmfRefreshWorkshopCaveat').classList.toggle('hidden', !item.isWorkshop);
  $g('rmfRefreshConfirmModal').classList.remove('hidden');
  await rmfLoadRefreshRevisions(slugInfo.slug);
}

// A "not yet downloaded" row's own Fetch action (queue: rebuild-missing-vortex-db-read) -- unlike
// rmfStartRefresh above, the Nexus slug is already known directly from the Vortex-DB scan
// (scanAllCollections reads attributes###collectionSlug itself), so this skips the /nexus-slug
// lookup entirely and goes straight to the revision picker. Reuses the SAME confirm modal --
// `isFirstFetch: true` on the pending state below is what the modal text and the Workshop caveat
// (always shown here -- every "not yet downloaded" row is inherently Workshop-only, unlike
// rmfStartRefresh's per-item `item.isWorkshop` check) branch on.
async function rmfStartFirstFetch(item, btn) {
  rmfPendingRefresh = { item, slug: item.collectionSlug, collectionModId: item.folder, isFirstFetch: true };
  $g('rmfRefreshError').classList.add('hidden');
  $g('rmfRefreshResult').classList.add('hidden');
  $g('rmfRefreshConfirmModalText').textContent =
    `This fetches "${item.name}" from Nexus and creates its local collection.json — it's never been ` +
    `downloaded here before, so there's nothing to back up.`;
  $g('rmfRefreshWorkshopCaveat').classList.remove('hidden');
  $g('rmfRefreshConfirmModal').classList.remove('hidden');
  await rmfLoadRefreshRevisions(item.collectionSlug);
}

// Real gap found live while testing this feature (queue: rebuild-missing-refresh-collection-json):
// a Workshop-authored collection is very often draft/unlisted-only on Nexus (never fully published)
// -- fetching "the latest published revision" alone came back "No PUBLISHED revision found... it may
// still be in draft" for every one of the director's own real collections tested. Mirrors app.js's
// own lookupRevisions -- same reasoning: "draft" means "not publicly listed yet," not "not real,"
// so every revision is listed, newest first, defaulting to the newest (whatever its status).
async function rmfLoadRefreshRevisions(slug) {
  const select = $g('rmfRefreshRevSelect');
  select.innerHTML = '';
  select.disabled = true;
  select.appendChild(el('option', { value: '' }, 'Looking up revisions…'));
  try {
    const data = await rmfApi('GET', `/api/rebuild-missing/nexus-revisions?slug=${encodeURIComponent(slug)}`);
    select.innerHTML = '';
    if (!data.revisions || data.revisions.length === 0) {
      select.appendChild(el('option', { value: '' }, 'No revisions found'));
      return;
    }
    for (const r of data.revisions) {
      const when = new Date(r.updatedAt).toLocaleDateString();
      const statusTag = r.revisionStatus === 'published' ? 'published' : 'draft, not public';
      select.appendChild(el('option', { value: String(r.revisionNumber) }, `Revision ${r.revisionNumber} — updated: ${when} (${statusTag})`));
    }
    select.disabled = false;
  } catch (e) {
    select.innerHTML = '';
    select.appendChild(el('option', { value: '' }, 'Lookup failed'));
  }
}

$g('rmfRefreshConfirmCancelBtn').addEventListener('click', () => {
  rmfPendingRefresh = null;
  $g('rmfRefreshConfirmModal').classList.add('hidden');
});

$g('rmfRefreshConfirmOkBtn').addEventListener('click', async () => {
  $g('rmfRefreshConfirmModal').classList.add('hidden');
  const pending = rmfPendingRefresh;
  rmfPendingRefresh = null;
  if (!pending) return;
  const { item, slug, collectionModId, isFirstFetch } = pending;
  const revisionNumber = $g('rmfRefreshRevSelect').value || undefined;
  $g('rmfRefreshResult').classList.add('hidden');
  try {
    const result = await rmfApi('POST', '/api/rebuild-missing/refresh-from-nexus', { collectionModId, slug, revisionNumber });
    if (isFirstFetch) {
      $g('rmfRefreshResult').textContent =
        `Fetched "${item.name}" from Nexus (revision ${result.revisionNumber}) — ${result.modCount} mod${result.modCount === 1 ? '' : 's'}. ` +
        `It now shows up under "Workshop collections" below, ready to scan.`;
      $g('rmfRefreshResult').classList.remove('hidden');
      // The server already dropped this from "not yet downloaded" (a real collection.json exists
      // now); a full reload picks that up plus the new "Workshop collections" card via the plain
      // filesystem scan, same one every other row already goes through.
      await rmfLoadCollections();
    } else {
      rmfApplyRefreshResult(item, result);
    }
  } catch (e) {
    rmfHandleError(e, $g('rmfRefreshError'));
  }
});

function rmfApplyRefreshResult(item, result) {
  item.modCount = result.modCount;
  if (item.subLineEl) item.subLineEl.textContent = `${item.modCount} mod${item.modCount === 1 ? '' : 's'}`;
  const before = result.previousModCount != null ? `${result.previousModCount} mod${result.previousModCount === 1 ? '' : 's'}` : 'unknown';
  $g('rmfRefreshResult').textContent =
    `Refreshed "${item.name}" from Nexus (revision ${result.revisionNumber}) — now ${result.modCount} mod${result.modCount === 1 ? '' : 's'}, was ${before}. ` +
    `The previous file is saved at ${result.backupPath}.`;
  $g('rmfRefreshResult').classList.remove('hidden');
}
