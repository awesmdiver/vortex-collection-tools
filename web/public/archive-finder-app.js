'use strict';
// Archive Finder (Utilities sub-tab) -- folded in 2026-07-28 from the standalone "Archive File
// Finder" project (see TECHNICAL.md's "Archive Finder" section for the full writeup). Reuses
// $g/el from cleanup-app.js, same "self-contained area, shared tiny helpers" convention already
// used across this project's other *-app.js files.

const afState = {
  configured: false,
  mode: 'files', // 'files' | 'archives'
  selected: new Map(), // key `${archivePath}|${internalPath}` -> item
  renderMode: 'files', // mode of the currently-rendered result set (survives tree browsing)
  currentUnits: [], // top-level rows for the active mode: file groups, or archive rows
  pageSize: 25, // 10 | 25 | 50 | 'all'
  page: 1,
  stats: null,
  extensions: ['.esp'],
  outputFolder: '',
};

const AF_ITEM_KEY = (archivePath, internalPath) => `${archivePath}|${internalPath}`;
const AF_PAGE_SIZE = 25;

async function afApi(method, path, body) {
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

function afHandleError(e) {
  $g('afScanLoading').classList.add('hidden');
  if (e instanceof TypeError) {
    const box = $g('afCriticalError');
    box.textContent = '';
    box.appendChild(el('div', { class: 'callout__title' }, '🛑 Can’t Reach the App’s Server'));
    box.appendChild(el('p', {}, 'The local server that runs this app isn’t responding right now. If you closed the window running it (or it crashed), you’ll need to start it back up—clicking Refresh alone won’t fix it until the server itself is running again.'));
    box.classList.remove('hidden');
    return;
  }
  const box = $g('afCriticalError');
  box.textContent = e.message;
  box.classList.remove('hidden');
}

function afFmtDate(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function afFmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- Load / config ----------

let afPageLoaded = false;
async function loadArchiveFinderPageOnce() {
  if (afPageLoaded) return;
  afPageLoaded = true;
  await afLoadConfig();
  if (afState.configured) await afLoadStats();
  afRunSearch();
}

async function afLoadConfig() {
  $g('afCriticalError').classList.add('hidden');
  try {
    const cfg = await afApi('GET', '/api/archive-finder/config');
    afState.configured = cfg.configured;
    afState.extensions = cfg.extensions || ['.esp'];
    afState.outputFolder = cfg.outputFolder || '';
    $g('afNotConfigured').classList.toggle('hidden', cfg.configured);
    if (!cfg.configured) {
      $g('afNotConfigured').textContent = 'Set up your Vortex downloads folder and Archive Finder database folder under Settings first.';
      $g('afMain').classList.add('hidden');
      return;
    }
    $g('afMain').classList.remove('hidden');
    afRenderExtensionTags();
  } catch (e) {
    afHandleError(e);
  }
}

async function afLoadStats() {
  const stats = await afApi('GET', '/api/archive-finder/stats');
  afState.stats = stats;
  $g('afStatsMeta').innerHTML = '';
  $g('afStatsMeta').appendChild(el('span', { class: 'accent-count' }, stats.archiveCount.toLocaleString()));
  $g('afStatsMeta').appendChild(document.createTextNode(' archives indexed · '));
  $g('afStatsMeta').appendChild(el('span', { class: 'accent-count' }, stats.fileCount.toLocaleString()));
  $g('afStatsMeta').appendChild(document.createTextNode(` files matched · last scan ${afFmtDate(stats.lastScanned)}`));
  const wrap = $g('afFailedLinkWrap');
  if (stats.errorCount) {
    $g('afFailedLinkAnchor').textContent = `${stats.errorCount} archive${stats.errorCount === 1 ? '' : 's'} failed to read`;
    wrap.classList.remove('hidden');
  } else {
    wrap.classList.add('hidden');
  }
}

// ---------- Extension tags ----------

function afRenderExtensionTags() {
  const container = $g('afExtensionTags');
  container.innerHTML = '';
  for (const ext of afState.extensions) {
    const removeBtn = el('button', { class: 'af-tag-remove', type: 'button', 'aria-label': 'remove' }, '×');
    removeBtn.addEventListener('click', () => {
      afState.extensions = afState.extensions.filter((e) => e !== ext);
      afRenderExtensionTags();
      afSaveExtensions();
    });
    container.appendChild(el('span', { class: 'badge badge--info' }, [ext + ' ', removeBtn]));
  }
}

function afNormalizeExtension(raw) {
  let ext = raw.trim().toLowerCase();
  if (!ext) return null;
  if (!ext.startsWith('.')) ext = '.' + ext;
  return ext;
}

async function afSaveExtensions() {
  try {
    await afApi('POST', '/api/archive-finder/config', { extensions: afState.extensions });
  } catch (e) {
    afHandleError(e);
  }
}

$g('afAddExtensionBtn').addEventListener('click', () => {
  const ext = afNormalizeExtension($g('afNewExtensionInput').value);
  $g('afNewExtensionInput').value = '';
  if (!ext || afState.extensions.includes(ext)) return;
  afState.extensions.push(ext);
  afRenderExtensionTags();
  afSaveExtensions();
});
$g('afNewExtensionInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $g('afAddExtensionBtn').click(); }
});

// ---------- Scan ----------

let afScanEventSource = null;

$g('afRescanBtn').addEventListener('click', async () => {
  $g('afRescanBtn').disabled = true;
  const wrap = $g('afScanProgressWrap');
  wrap.classList.remove('hidden');
  $g('afScanProgressBar').style.width = '0%';
  $g('afScanProgressText').textContent = 'Starting scan…';
  $g('afScanLoading').classList.remove('hidden');

  try {
    await afApi('POST', '/api/archive-finder/scan');
  } catch (e) {
    // A 409 here just means a scan is already running (e.g. from another tab) -- still attach
    // below to watch its progress, same as if this tab had started it.
    if (e.status !== 409) {
      afHandleError(e);
      $g('afRescanBtn').disabled = false;
      $g('afScanLoading').classList.add('hidden');
      return;
    }
  }

  if (afScanEventSource) afScanEventSource.close();
  const es = new EventSource('/api/archive-finder/scan/events');
  afScanEventSource = es;
  es.onmessage = (msg) => afHandleScanEvent(JSON.parse(msg.data));
});

function afHandleScanEvent(frame) {
  if (frame.type === 'progress') {
    if (frame.phase === 'listing') {
      $g('afScanProgressText').textContent = frame.message;
    } else {
      const pct = frame.total ? Math.round((frame.current / frame.total) * 100) : 100;
      $g('afScanProgressBar').style.width = pct + '%';
      $g('afScanProgressText').textContent = `${frame.current} / ${frame.total} — ${frame.message}`;
    }
  } else if (frame.type === 'done') {
    $g('afScanProgressText').textContent =
      `Done: ${frame.scanned} scanned, ${frame.skipped} unchanged, ${frame.removed} removed` +
      (frame.errors ? `, ${frame.errors} failed to read` : '');
    $g('afScanProgressBar').style.width = '100%';
    $g('afRescanBtn').disabled = false;
    $g('afScanLoading').classList.add('hidden');
    if (afScanEventSource) { afScanEventSource.close(); afScanEventSource = null; }
    afLoadStats();
  } else if (frame.type === 'error') {
    $g('afScanProgressText').textContent = frame.message || 'Scan failed.';
    $g('afRescanBtn').disabled = false;
    $g('afScanLoading').classList.add('hidden');
    if (afScanEventSource) { afScanEventSource.close(); afScanEventSource = null; }
  }
}

// ---------- Search ----------

document.querySelectorAll('input[name=afSearchMode]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    if (!e.target.checked) return;
    afState.mode = e.target.value;
    afCloseTree();
    afRunSearch();
  });
});

let afSearchDebounce = null;
$g('afSearchInput').addEventListener('input', () => {
  clearTimeout(afSearchDebounce);
  afSearchDebounce = setTimeout(afRunSearch, 200);
});
$g('afSearchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  clearTimeout(afSearchDebounce);
  afRunSearch();
});
$g('afSearchBtn').addEventListener('click', () => {
  clearTimeout(afSearchDebounce);
  afRunSearch();
});

function afShowEmptyResults(message) {
  afState.currentUnits = [];
  $g('afResultsTable').classList.add('hidden');
  $g('afArchiveResultsList').classList.add('hidden');
  $g('afPaginationBar').classList.add('hidden');
  const empty = $g('afNoResults');
  empty.textContent = message;
  empty.classList.remove('hidden');
}

async function afRunSearch() {
  if (!afState.configured) return;
  const q = $g('afSearchInput').value.trim();
  $g('afTreePanel').classList.add('hidden');
  $g('afNoResults').classList.add('hidden');

  if (afState.stats && afState.stats.archiveCount === 0) {
    afShowEmptyResults('No data available — nothing has been scanned yet. Click Save & Rescan above first.');
    return;
  }
  if (!q) {
    afShowEmptyResults('No matches yet. Type a mod name above.');
    return;
  }

  let rows;
  try {
    rows = await afApi('GET', `/api/archive-finder/search?q=${encodeURIComponent(q)}&mode=${afState.mode}`);
  } catch (e) {
    afHandleError(e);
    return;
  }
  if (!rows.length) {
    afShowEmptyResults(`No matches found for "${q}".`);
    return;
  }

  afState.renderMode = afState.mode;
  afState.currentUnits = afState.mode === 'files' ? afGroupFileRows(rows) : rows;
  afState.page = 1;
  afRenderCurrentPage();
}

// Rows come pre-sorted (archive name, then file name) from the API, so consecutive rows sharing
// an archive are already contiguous -- group them so an archive with many matches collapses to
// one "N matching files" row instead of flooding the list.
function afGroupFileRows(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.archivePath !== row.archivePath) {
      current = { archivePath: row.archivePath, archiveName: row.archiveName, items: [] };
      groups.push(current);
    }
    current.items.push(row);
  }
  return groups;
}

function afPaginate(units) {
  const total = units.length;
  const size = afState.pageSize === 'all' ? Math.max(total, 1) : afState.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / size));
  if (afState.page > totalPages) afState.page = totalPages;
  const start = (afState.page - 1) * size;
  return { pageItems: units.slice(start, start + size), totalPages, total };
}

function afRenderCurrentPage() {
  $g('afResultsTable').classList.add('hidden');
  $g('afArchiveResultsList').classList.add('hidden');
  $g('afTreePanel').classList.add('hidden');

  const { pageItems, totalPages, total } = afPaginate(afState.currentUnits);
  if (!total) {
    $g('afPaginationBar').classList.add('hidden');
    return;
  }
  if (afState.renderMode === 'files') afRenderFileResultsPage(pageItems);
  else afRenderArchiveResultsPage(pageItems);
  afUpdatePaginationBar(totalPages, total);
}

function afUpdatePaginationBar(totalPages, total) {
  const bar = $g('afPaginationBar');
  bar.classList.remove('hidden');
  $g('afPageIndicator').textContent = `Page ${afState.page} of ${totalPages} (${total} result${total === 1 ? '' : 's'})`;
  $g('afPrevPageBtn').disabled = afState.page <= 1;
  $g('afNextPageBtn').disabled = afState.page >= totalPages;
  document.querySelectorAll('.af-page-size-btn').forEach((btn) => {
    const v = btn.dataset.size === 'all' ? 'all' : Number(btn.dataset.size);
    const active = v === afState.pageSize;
    btn.classList.toggle('btn--primary', active);
    btn.classList.toggle('btn--ghost', !active);
  });
}

document.querySelectorAll('.af-page-size-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    afState.pageSize = btn.dataset.size === 'all' ? 'all' : Number(btn.dataset.size);
    afState.page = 1;
    afRenderCurrentPage();
  });
});
$g('afPrevPageBtn').addEventListener('click', () => {
  if (afState.page > 1) { afState.page--; afRenderCurrentPage(); }
});
$g('afNextPageBtn').addEventListener('click', () => {
  afState.page++; afRenderCurrentPage();
});

function afRenderFileResultsPage(groups) {
  $g('afResultsTable').classList.remove('hidden');
  const body = $g('afResultsBody');
  body.innerHTML = '';
  for (const group of groups) {
    if (group.items.length === 1) {
      body.appendChild(afBuildFileRow(group.items[0], false));
      continue;
    }
    body.appendChild(afBuildGroupRow(group));
    for (const row of group.items) {
      const tr = afBuildFileRow(row, true);
      tr.classList.add('hidden');
      body.appendChild(tr);
    }
  }
}

function afBuildFileRow(row, indented) {
  const key = AF_ITEM_KEY(row.archivePath, row.internalPath);
  const checkbox = el('input', { type: 'checkbox' });
  if (afState.selected.has(key)) checkbox.checked = true;
  const item = { archivePath: row.archivePath, internalPath: row.internalPath, fileName: row.fileName, archiveName: row.archiveName };
  checkbox.addEventListener('change', (e) => {
    if (e.target.checked) afState.selected.set(key, item);
    else afState.selected.delete(key);
    afUpdateSelectionCount();
    if (indented) afSyncGroupCheckbox(tr);
  });
  const tr = el('tr', indented ? { class: 'group-child' } : {}, [
    el('td', { class: 'col-check' }, [checkbox]),
    el('td', {}, row.fileName),
    el('td', {}, row.extension),
    el('td', {}, indented ? '' : row.archiveName),
  ]);
  return tr;
}

function afBuildGroupRow(group) {
  const items = group.items.map((row) => ({ archivePath: row.archivePath, internalPath: row.internalPath, fileName: row.fileName, archiveName: row.archiveName }));
  const selectedCount = items.filter((it) => afState.selected.has(AF_ITEM_KEY(it.archivePath, it.internalPath))).length;

  const groupCheckbox = el('input', { type: 'checkbox' });
  groupCheckbox.checked = selectedCount === items.length;
  groupCheckbox.indeterminate = selectedCount > 0 && selectedCount < items.length;

  const toggleBtn = el('button', { type: 'button', class: 'sync-list-toggle' }, `▶ ${items.length} matching files`);

  const tr = el('tr', { class: 'group-row' }, [
    el('td', { class: 'col-check' }, [groupCheckbox]),
    el('td', {}, [toggleBtn]),
    el('td', {}, '—'),
    el('td', {}, group.archiveName),
  ]);

  groupCheckbox.addEventListener('change', () => {
    const checked = groupCheckbox.checked;
    groupCheckbox.indeterminate = false;
    for (const it of items) {
      const key = AF_ITEM_KEY(it.archivePath, it.internalPath);
      if (checked) afState.selected.set(key, it);
      else afState.selected.delete(key);
    }
    afUpdateSelectionCount();
    let sib = tr.nextElementSibling;
    while (sib && sib.classList.contains('group-child')) {
      sib.querySelector('input[type=checkbox]').checked = checked;
      sib = sib.nextElementSibling;
    }
  });

  toggleBtn.addEventListener('click', () => {
    let sib = tr.nextElementSibling;
    const wasCollapsed = sib && sib.classList.contains('hidden');
    while (sib && sib.classList.contains('group-child')) {
      sib.classList.toggle('hidden');
      sib = sib.nextElementSibling;
    }
    toggleBtn.textContent = `${wasCollapsed ? '▼' : '▶'} ${items.length} matching files`;
  });

  return tr;
}

function afSyncGroupCheckbox(childRow) {
  let groupRow = childRow.previousElementSibling;
  while (groupRow && !groupRow.classList.contains('group-row')) {
    groupRow = groupRow.previousElementSibling;
  }
  if (!groupRow) return;
  const groupCheckbox = groupRow.querySelector('input[type=checkbox]');
  let sib = groupRow.nextElementSibling;
  let total = 0;
  let checkedCount = 0;
  while (sib && sib.classList.contains('group-child')) {
    total++;
    if (sib.querySelector('input[type=checkbox]').checked) checkedCount++;
    sib = sib.nextElementSibling;
  }
  groupCheckbox.checked = total > 0 && checkedCount === total;
  groupCheckbox.indeterminate = checkedCount > 0 && checkedCount < total;
}

function afRenderArchiveResultsPage(rows) {
  const list = $g('afArchiveResultsList');
  list.classList.remove('hidden');
  list.innerHTML = '';
  for (const row of rows) {
    const children = [
      el('span', {}, row.archiveName),
      el('span', { class: 'muted', style: 'margin-left: 10px;' }, afFmtSize(row.size)),
    ];
    if (row.scanError) children.push(el('span', { class: 'badge badge--critical', style: 'margin-left: 10px;', title: row.scanError }, 'unreadable'));
    const li = el('li', {}, children);
    if (!row.scanError) {
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => afOpenTree(row));
    } else {
      li.style.opacity = '0.6';
    }
    list.appendChild(li);
  }
}

async function afOpenTree(archiveRow) {
  $g('afArchiveResultsList').classList.add('hidden');
  const panel = $g('afTreePanel');
  panel.classList.remove('hidden');
  $g('afTreeArchiveName').textContent = archiveRow.archiveName;
  const body = $g('afTreeBody');
  body.textContent = 'Loading contents…';
  try {
    const data = await afApi('GET', `/api/archive-finder/archive-tree?id=${archiveRow.archiveId}`);
    body.innerHTML = '';
    body.appendChild(afRenderTreeNode(data.tree, data.archivePath, true));
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'muted' }, e.message));
  }
}

function afRenderTreeNode(node, archivePath, isRoot) {
  if (node.type === 'file') {
    const key = AF_ITEM_KEY(archivePath, node.internalPath);
    const checkbox = el('input', { type: 'checkbox' });
    if (afState.selected.has(key)) checkbox.checked = true;
    const item = { archivePath, internalPath: node.internalPath, fileName: node.name, archiveName: afArchivePathBaseName(archivePath) };
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) afState.selected.set(key, item);
      else afState.selected.delete(key);
      afUpdateSelectionCount();
    });
    return el('div', { style: 'display: flex; gap: 10px; align-items: center; padding: 4px 0;' }, [
      checkbox,
      el('span', {}, node.name),
      el('span', { class: 'muted' }, afFmtSize(node.size)),
    ]);
  }

  if (isRoot) {
    const container = document.createElement('div');
    for (const child of node.children) container.appendChild(afRenderTreeNode(child, archivePath, false));
    return container;
  }

  const details = el('details', {}, [el('summary', {}, node.name)]);
  for (const child of node.children) details.appendChild(afRenderTreeNode(child, archivePath, false));
  return details;
}

function afArchivePathBaseName(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

$g('afCloseTreeBtn').addEventListener('click', afCloseTree);
function afCloseTree() {
  $g('afTreePanel').classList.add('hidden');
  if (afState.mode === 'archives' && afState.currentUnits.length) afRenderCurrentPage();
}

function afUpdateSelectionCount() {
  $g('afSelectionCount').textContent = `${afState.selected.size} selected`;
}

$g('afSelectAllBtn').addEventListener('click', () => {
  document.querySelectorAll('#afResultsBody input[type=checkbox]').forEach((cb) => {
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  });
});
$g('afClearSelectionBtn').addEventListener('click', () => {
  afState.selected.clear();
  document.querySelectorAll('#afResultsBody input[type=checkbox], #afTreeBody input[type=checkbox]').forEach((cb) => { cb.checked = false; cb.indeterminate = false; });
  afUpdateSelectionCount();
});

// ---------- Extraction ----------

$g('afExtractBtn').addEventListener('click', () => {
  if (!afState.selected.size) return;
  $g('afExtractCount').textContent = afState.selected.size;
  $g('afExtractDestInput').value = afState.outputFolder;
  $g('afExtractResults').innerHTML = '';
  $g('afExtractModal').classList.remove('hidden');
});
$g('afExtractCancelBtn').addEventListener('click', () => {
  $g('afExtractModal').classList.add('hidden');
});
$g('afExtractBrowseBtn').addEventListener('click', async () => {
  try {
    const res = await afApi('POST', '/api/settings/browse-folder', { title: 'Choose an extraction destination', initialDir: $g('afExtractDestInput').value.trim() || undefined });
    if (res.path) $g('afExtractDestInput').value = res.path;
  } catch (e) {
    afHandleError(e);
  }
});
$g('afExtractConfirmBtn').addEventListener('click', async () => {
  const outputFolder = $g('afExtractDestInput').value.trim();
  const flat = $g('afExtractFlatInput').checked;
  const items = Array.from(afState.selected.values()).map((it) => ({ archivePath: it.archivePath, internalPath: it.internalPath }));
  const labels = Array.from(afState.selected.values());
  $g('afExtractConfirmBtn').disabled = true;
  const resultsEl = $g('afExtractResults');
  resultsEl.textContent = 'Extracting…';
  try {
    const res = await afApi('POST', '/api/archive-finder/extract', { items, outputFolder, flat });
    afState.outputFolder = res.outputFolder;
    resultsEl.innerHTML = '';
    res.results.forEach((r, i) => {
      const label = labels[i] ? labels[i].fileName : r.key;
      resultsEl.appendChild(r.ok
        ? el('p', { class: 'ok' }, `✓ ${label} → ${r.path}`)
        : el('p', { class: 'fail' }, `✗ ${label}: ${r.error}`));
    });
  } catch (e) {
    resultsEl.textContent = '';
    resultsEl.appendChild(el('p', { class: 'fail' }, e.message));
  } finally {
    $g('afExtractConfirmBtn').disabled = false;
  }
});

// ---------- Failed archives ----------

const afFailedSelected = new Set();
const afFailedNames = new Map();

$g('afFailedLinkAnchor').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const rows = await afApi('GET', '/api/archive-finder/failed-archives');
    afFailedSelected.clear();
    afRenderFailedList(rows);
    $g('afFailedResults').innerHTML = '';
    $g('afFailedModal').classList.remove('hidden');
  } catch (err) {
    afHandleError(err);
  }
});

function afRenderFailedList(rows) {
  const list = $g('afFailedList');
  list.innerHTML = '';
  afFailedNames.clear();
  for (const row of rows) {
    afFailedNames.set(row.archiveId, row.archiveName);
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) afFailedSelected.add(row.archiveId);
      else afFailedSelected.delete(row.archiveId);
      afUpdateFailedSelectionCount();
    });
    list.appendChild(el('li', {}, [
      checkbox,
      el('strong', { style: 'margin-left: 8px;' }, row.archiveName),
      el('span', { class: 'muted', style: 'display: block; margin-left: 24px;' }, row.scanError),
    ]));
  }
  afUpdateFailedSelectionCount();
}

function afUpdateFailedSelectionCount() {
  $g('afFailedSelectAllInput').checked = false;
}

$g('afFailedSelectAllInput').addEventListener('change', (e) => {
  document.querySelectorAll('#afFailedList input[type=checkbox]').forEach((cb) => {
    cb.checked = e.target.checked;
    cb.dispatchEvent(new Event('change'));
  });
});

$g('afFailedCloseBtn').addEventListener('click', () => {
  $g('afFailedModal').classList.add('hidden');
  afLoadStats();
});

$g('afFailedUntrackBtn').addEventListener('click', async () => {
  if (!afFailedSelected.size) return;
  const archiveIds = Array.from(afFailedSelected);
  try {
    const res = await afApi('POST', '/api/archive-finder/failed-archives/untrack', { archiveIds });
    afReportFailedAction(res.results, 'Removed from index');
    const remaining = await afApi('GET', '/api/archive-finder/failed-archives');
    afFailedSelected.clear();
    afRenderFailedList(remaining);
  } catch (e) {
    afHandleError(e);
  }
});

// Serious register -- a permanent, no-undo disk delete. Confirm modal (not a native confirm())
// matches this project's own established pattern for destructive actions (see cleanupDeleteConfirmModal).
let afPendingFailedDeleteIds = null;
$g('afFailedDeleteBtn').addEventListener('click', () => {
  if (!afFailedSelected.size) return;
  afPendingFailedDeleteIds = Array.from(afFailedSelected);
  $g('afDeleteConfirmModalText').textContent = `This permanently deletes ${afPendingFailedDeleteIds.length} file(s) from disk. This cannot be undone.`;
  $g('afDeleteConfirmModal').classList.remove('hidden');
});
$g('afDeleteConfirmCancelBtn').addEventListener('click', () => {
  $g('afDeleteConfirmModal').classList.add('hidden');
  afPendingFailedDeleteIds = null;
});
$g('afDeleteConfirmOkBtn').addEventListener('click', async () => {
  $g('afDeleteConfirmModal').classList.add('hidden');
  const archiveIds = afPendingFailedDeleteIds;
  afPendingFailedDeleteIds = null;
  if (!archiveIds) return;
  try {
    const res = await afApi('POST', '/api/archive-finder/failed-archives/delete-file', { archiveIds });
    afReportFailedAction(res.results, 'Deleted from disk');
    const remaining = await afApi('GET', '/api/archive-finder/failed-archives');
    afFailedSelected.clear();
    afRenderFailedList(remaining);
  } catch (e) {
    afHandleError(e);
  }
});

function afReportFailedAction(results, okLabel) {
  const resultsEl = $g('afFailedResults');
  resultsEl.innerHTML = '';
  for (const r of results) {
    const name = afFailedNames.get(r.archiveId) || `archive #${r.archiveId}`;
    resultsEl.appendChild(r.ok
      ? el('p', { class: 'ok' }, `✓ ${okLabel}: ${name}`)
      : el('p', { class: 'fail' }, `✗ ${name}: ${r.error}`));
  }
}
