'use strict';
// Merge Plugins (The Forge) -- see TECHNICAL.md's "Merge engine" section for the full design
// writeup (the xelib engine, the child-process worker, the v1.0 new-record-only scope). Own tiny
// $m()/mergeApi() helpers, same "self-contained area" convention as every other *-app.js file here.
// Reuses el() from cleanup-app.js (already loaded first) for DOM building.

function $m(id) { return document.getElementById(id); }

async function mergeApi(method, path, body) {
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

function mergeHandleError(e, retryFn) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(() => {});
    return;
  }
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    // retryFn re-runs whatever action hit the gate (e.g. re-analyzing, re-starting the merge) --
    // without it, the modal's own "Try Again" button just dismisses the modal and does nothing,
    // leaving the user stuck exactly where they were (confirmed real 2026-07-28: this had been a
    // no-op the whole time, unlike every other tool's own showVortexRunningModal call).
    window.showVortexRunningModal(retryFn || (() => {}));
    return;
  }
  const box = $m('mergeCriticalError');
  box.textContent = '';
  box.appendChild(el('div', { class: 'callout__title' }, "🛑 Couldn't do that"));
  box.appendChild(el('p', {}, e.message));
  box.classList.remove('hidden');
}
function mergeHideError() {
  $m('mergeCriticalError').classList.add('hidden');
  $m('mergeCriticalError').innerHTML = '';
}

const MERGE_STEPS = ['Collections', 'Find files', 'Review', 'Merge', 'Done'];
const MERGE_ITEM_KEY = (item) => item.fullPath;

const mergeState = {
  step: 0,
  collections: [], // every installed collection, from the server
  collSelected: new Set(), // chosen modIds (Step 0)
  extensions: ['.esp', '.esl', '.esm'],
  searchResults: [], // the CURRENT search's full result set (flat, across all its pages)
  cart: new Map(), // fullPath -> item -- accumulates across every search, never reset by a new one
  pageSize: 25,
  page: 1,
  reviewItems: [], // after analyze(): cart items + {recordCount, newRecordCount, containsOverrides, masters, status}
  outputDir: '',
  // Masters-dependency reverse-index (2026-08-17) -- lowercased plugin filename -> [{fileName,
  // resolvedItem}] for every OTHER active plugin that declares it as a master. Fetched once on
  // boot (drives the "(master)" label everywhere a plugin name is shown) and re-fetched fresh right
  // before a real build starts (mergeCheckMasterDependencies) -- see mergeLoadMasterDependents' own
  // comment for why both matter. Empty object until the first successful fetch.
  masterDependents: {},
};
let mergeLastClickedCheckbox = null; // shift-click range select, Step 1's results table
let mergeCartWindow = null; // the live-updating separate OS window ("View chosen")
let mergeEventSource = null; // SSE for the Merging… step's progress
// Review step's status filter -- a Set of active statuses ('master'/'override'/'ok'), empty shows
// everything. Multi-select, each badge toggles independently (workspace UX-PRINCIPLES.md rule 7,
// applied app-wide 2026-08-15) -- module-level so it survives a re-render of the badges themselves
// (e.g. removing an item from the cart re-runs mergeRenderReviewStep, which used to always reset
// back to "Show all" since the old markup hardcoded badge--filter-active on the "all" badge).
let mergeReviewFilter = new Set();

// Sortable File/Mod headers (2026-08-17) -- one sort-state object per table (Step 1's results table
// and Step 2's review table are two independent datasets/tables). `column` is null (unsorted, the
// server's own default order) until a header's first click, then toggles asc/desc on repeat clicks
// of the SAME column; clicking the OTHER column switches to sorting by that one instead, always
// starting ascending -- same "only one column sorts at a time" single-sort-state convention
// Workshop Report's own wrSortDirection already establishes for its one sortable column, extended
// here to two.
const mergeResultsSort = { column: null, direction: 'asc' };
const mergeReviewSort = { column: null, direction: 'asc' };

// Renders a SORTED COPY -- never mutates the array passed in, so callers that also rely on that
// array's own order (e.g. mergeState.reviewItems, which mergeStartMerge reads directly for the
// actual merge order) are never affected by display sorting.
function mergeSortedRows(items, sortState) {
  if (!sortState.column) return items;
  const col = sortState.column;
  const sorted = [...items].sort((a, b) => String(a[col] || '').localeCompare(String(b[col] || '')));
  return sortState.direction === 'desc' ? sorted.reverse() : sorted;
}

function mergeHandleHeaderSortClick(sortState, column, rerenderFn) {
  if (sortState.column === column) {
    sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.column = column;
    sortState.direction = 'asc';
  }
  rerenderFn();
}

function mergeRenderSortArrows(sortState, arrows) {
  // arrows: { column: arrowElementId } -- clears every arrow except the currently-sorted column's.
  for (const [column, id] of Object.entries(arrows)) {
    $m(id).textContent = sortState.column === column ? (sortState.direction === 'asc' ? '▲' : '▼') : '';
  }
}

// ---------- Stepper + navigation ----------

function mergeRenderStepper() {
  $m('mergeStepper').innerHTML = MERGE_STEPS.map((label, i) => {
    const cls = i === mergeState.step ? 'active' : i < mergeState.step ? 'done' : '';
    const num = i < mergeState.step ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}

function mergeGoToStep(n) {
  mergeState.step = n;
  mergeRenderStepper();
  for (let i = 0; i < 5; i++) $m(`mergeStep${i}`).classList.toggle('hidden', i !== n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (n === 1) mergeEnterStep1();
  if (n === 2) mergeEnterStep2();
}

// ---------- Step 0: choose collections ----------

// Top-level tool area (not a shared Utilities/Reports sub-tab), so it loads eagerly at script-load
// time regardless of which area happens to be visible first -- same convention as app.js's own
// unconditional loadCollections() call at the bottom of that file.
async function loadMergeOnBoot() {
  try {
    const cfg = await mergeApi('GET', '/api/settings');
    mergeState.outputDir = cfg.mergeOutputDir || '';
  } catch { /* Settings not reachable yet -- output folder just starts blank, not fatal */ }
  // Non-blocking, non-fatal -- the "(master)" label is a nice-to-have, not something that should
  // ever stop the collection picker from loading if the Data folder/Plugins.txt aren't configured
  // yet (a brand-new install, before Settings is filled in). Re-fetched fresh again right before a
  // real build starts (mergeCheckMasterDependencies) -- this boot-time copy is just for display.
  mergeLoadMasterDependents();
  await mergeLoadCollections();
}

async function mergeLoadMasterDependents() {
  try {
    const { dependents } = await mergeApi('GET', '/api/merge/master-dependents');
    mergeState.masterDependents = dependents || {};
  } catch { /* not configured yet, or a transient read error -- (master) labels just stay off this session */ }
}

// Returns a DOM node (a muted, hoverable " (master)" suffix) if OTHER active plugins depend on this
// one, or null otherwise -- for el()'s own children array, which already skips null entries.
// Director's ask: "wherever a plugin's file name is shown". Same reverse-index Part 1's own
// pre-flight check reuses (mergeState.masterDependents), never a second computation.
function mergeMasterBadge(fileName) {
  const deps = mergeState.masterDependents[fileName.toLowerCase()];
  if (!deps || !deps.length) return null;
  return el('span', { class: 'muted', title: `Needed by: ${deps.map((d) => d.fileName).join(', ')}` }, ' (master)');
}

// Same signal as mergeMasterBadge above, but for the cart window's own raw-HTML-string rendering
// (window.open + document.write, not el()) -- see mergeCartWindowBodyHtml's own comment.
function mergeMasterBadgeHtml(fileName) {
  const deps = mergeState.masterDependents[fileName.toLowerCase()];
  if (!deps || !deps.length) return '';
  return ` <span class="muted" title="Needed by: ${escMergeHtml(deps.map((d) => d.fileName).join(', '))}">(master)</span>`;
}

async function mergeLoadCollections() {
  mergeHideError();
  $m('mergeCollLoading').classList.remove('hidden');
  $m('mergeCollList').classList.add('hidden');
  try {
    const { collections } = await mergeApi('GET', '/api/merge/collections');
    mergeState.collections = collections;
    $m('mergeCollLoading').classList.add('hidden');
    if (!collections.length) {
      $m('mergeCollEmpty').textContent = 'No installed collections found. Set up your staging folder under Settings, or install a collection in Vortex first.';
      $m('mergeCollEmpty').classList.remove('hidden');
      return;
    }
    $m('mergeCollList').classList.remove('hidden');
    mergeRenderCollectionList();
  } catch (e) {
    $m('mergeCollLoading').classList.add('hidden');
    mergeHandleError(e);
  }
}

function mergeUpdateCollCount() {
  const n = mergeState.collSelected.size;
  const m = mergeState.collections.length;
  $m('mergeCollCount').textContent = m ? `${n} of ${m} selected` : '';
  $m('mergeStep0NextBtn').disabled = n === 0;
}

function mergeRenderCollectionList() {
  const list = $m('mergeCollList');
  list.innerHTML = '';
  for (const c of mergeState.collections) {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = mergeState.collSelected.has(c.modId);
    const row = el('label', { class: `merge-chk-row${checkbox.checked ? ' on' : ''}` }, [
      checkbox,
      el('span', { class: 'merge-chk-row__name' }, c.name),
      el('span', { class: 'merge-chk-row__meta' }, `${c.modCount.toLocaleString()} mods`),
    ]);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) mergeState.collSelected.add(c.modId);
      else mergeState.collSelected.delete(c.modId);
      row.classList.toggle('on', checkbox.checked);
      mergeUpdateCollCount();
    });
    list.appendChild(row);
  }
  mergeUpdateCollCount();
}

$m('mergeCollSelectAllBtn').addEventListener('click', () => {
  mergeState.collSelected = new Set(mergeState.collections.map((c) => c.modId));
  mergeRenderCollectionList();
});
$m('mergeCollClearBtn').addEventListener('click', () => {
  mergeState.collSelected.clear();
  mergeRenderCollectionList();
});
$m('mergeStep0NextBtn').addEventListener('click', () => mergeGoToStep(1));

// ---------- Step 1: find & select plugins ----------

function mergeEnterStep1() {
  const names = mergeState.collections.filter((c) => mergeState.collSelected.has(c.modId)).map((c) => c.name);
  $m('mergeStep1Sub').textContent = `Searching the plugins in your ${names.length} chosen collection${names.length === 1 ? '' : 's'}. Search as many times as you like — each pick adds to the merge and stays put.`;
  mergeRenderExtensionTags();
  mergeUpdateCartBar();
  if (!mergeState.searchResults.length) mergeRunSearch();
}

function mergeRenderExtensionTags() {
  const container = $m('mergeExtensionTags');
  container.innerHTML = '';
  for (const ext of mergeState.extensions) {
    const removeBtn = el('button', { class: 'af-tag-remove', type: 'button', 'aria-label': 'remove' }, '×');
    removeBtn.addEventListener('click', () => {
      mergeState.extensions = mergeState.extensions.filter((e) => e !== ext);
      mergeRenderExtensionTags();
      mergeRunSearch();
    });
    container.appendChild(el('span', { class: 'badge badge--info' }, [ext + ' ', removeBtn]));
  }
}
$m('mergeAddExtensionBtn').addEventListener('click', () => {
  let ext = $m('mergeNewExtensionInput').value.trim().toLowerCase();
  $m('mergeNewExtensionInput').value = '';
  if (!ext) return;
  if (!ext.startsWith('.')) ext = '.' + ext;
  if (mergeState.extensions.includes(ext)) return;
  mergeState.extensions.push(ext);
  mergeRenderExtensionTags();
  mergeRunSearch();
});
$m('mergeNewExtensionInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $m('mergeAddExtensionBtn').click(); }
});

let mergeSearchDebounce = null;
$m('mergeSearchInput').addEventListener('input', () => {
  clearTimeout(mergeSearchDebounce);
  mergeSearchDebounce = setTimeout(mergeRunSearch, 250);
});

async function mergeRunSearch() {
  mergeHideError();
  const q = $m('mergeSearchInput').value.trim();
  const collectionIds = [...mergeState.collSelected].join(',');
  try {
    const { results } = await mergeApi('GET', `/api/merge/plugins?collections=${encodeURIComponent(collectionIds)}&q=${encodeURIComponent(q)}&extensions=${encodeURIComponent(mergeState.extensions.join(','))}`);
    mergeState.searchResults = results;
    mergeState.page = 1;
    mergeRenderResultsPage();
    $m('mergeResultsSummary').textContent = q ? `Results for "${q}" · ${results.length} match${results.length === 1 ? '' : 'es'}` : `${results.length} plugin${results.length === 1 ? '' : 's'} found`;
    $m('mergeNoResults').textContent = results.length ? '' : 'No matching plugins found in your chosen collections.';
  } catch (e) {
    mergeHandleError(e);
  }
}

function mergePaginate(units) {
  const total = units.length;
  const size = mergeState.pageSize === 'all' ? Math.max(total, 1) : mergeState.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / size));
  if (mergeState.page > totalPages) mergeState.page = totalPages;
  const start = (mergeState.page - 1) * size;
  return { pageItems: units.slice(start, start + size), totalPages, total };
}

function mergeRenderResultsPage() {
  mergeRenderSortArrows(mergeResultsSort, { fileName: 'mergeResultsFileSortArrow', modName: 'mergeResultsModSortArrow' });
  const { pageItems, totalPages, total } = mergePaginate(mergeSortedRows(mergeState.searchResults, mergeResultsSort));
  $m('mergeSelectionActions').classList.toggle('hidden', !total);
  if (!total) {
    $m('mergeResultsTable').classList.add('hidden');
    $m('mergePaginationBar').classList.add('hidden');
    mergeHideSelectAllBanner();
    return;
  }
  $m('mergeResultsTable').classList.remove('hidden');
  const body = $m('mergeResultsBody');
  body.innerHTML = '';
  for (const item of pageItems) body.appendChild(mergeBuildResultRow(item));
  mergeUpdatePaginationBar(totalPages, total);
  mergeUpdateHeaderCheckboxState();
  mergeUpdateSelectionCount();
  mergeCheckSelectAllBanner();
}

function mergeBuildResultRow(item) {
  const key = MERGE_ITEM_KEY(item);
  const checkbox = el('input', { type: 'checkbox' });
  checkbox.checked = mergeState.cart.has(key);
  const typeClass = item.extension === '.esl' ? 'status-pill--info' : 'status-pill--neutral';
  const tr = el('tr', {}, [
    el('td', { class: 'col-check' }, [checkbox]),
    el('td', {}, [item.fileName, mergeMasterBadge(item.fileName)]),
    el('td', { class: 'muted' }, item.modName),
    el('td', { class: 'muted' }, item.collectionName),
    el('td', {}, [el('span', { class: `status-pill ${typeClass}` }, item.extension.slice(1).toUpperCase())]),
  ]);
  tr.dataset.key = key;
  tr.classList.toggle('selected', checkbox.checked);

  checkbox.addEventListener('click', (e) => {
    if (e.shiftKey && mergeLastClickedCheckbox && mergeLastClickedCheckbox !== checkbox) {
      mergeApplyShiftRange(mergeLastClickedCheckbox, checkbox, checkbox.checked);
    }
    mergeLastClickedCheckbox = checkbox;
  });
  checkbox.addEventListener('change', (e) => {
    mergeSetCartMembership(item, e.target.checked);
    tr.classList.toggle('selected', e.target.checked);
    mergeUpdateSelectionCount();
    mergeUpdateHeaderCheckboxState();
    mergeCheckSelectAllBanner();
    mergeUpdateCartBar();
    mergeRefreshCartWindow();
  });
  return tr;
}

function mergeApplyShiftRange(fromCb, toCb, checked) {
  const all = Array.from(document.querySelectorAll('#mergeResultsBody input[type=checkbox]'));
  const i1 = all.indexOf(fromCb);
  const i2 = all.indexOf(toCb);
  if (i1 === -1 || i2 === -1) return;
  const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
  for (let i = lo; i <= hi; i++) {
    const cb = all[i];
    if (cb === toCb) continue;
    if (cb.checked !== checked) {
      cb.checked = checked;
      cb.dispatchEvent(new Event('change'));
    }
  }
}

$m('mergeResultsFileHeader').addEventListener('click', () => mergeHandleHeaderSortClick(mergeResultsSort, 'fileName', mergeRenderResultsPage));
$m('mergeResultsModHeader').addEventListener('click', () => mergeHandleHeaderSortClick(mergeResultsSort, 'modName', mergeRenderResultsPage));

function mergeSetCartMembership(item, inCart) {
  const key = MERGE_ITEM_KEY(item);
  if (inCart) mergeState.cart.set(key, item);
  else mergeState.cart.delete(key);
}

function mergeRefreshRowsFromCart() {
  document.querySelectorAll('#mergeResultsBody tr').forEach((tr) => {
    const cb = tr.querySelector('input[type=checkbox]');
    const checked = mergeState.cart.has(tr.dataset.key);
    cb.checked = checked;
    tr.classList.toggle('selected', checked);
  });
  mergeUpdateHeaderCheckboxState();
}

function mergeUpdatePaginationBar(totalPages, total) {
  const bar = $m('mergePaginationBar');
  bar.classList.remove('hidden');
  $m('mergePageIndicator').textContent = `Page ${mergeState.page} of ${totalPages} (${total} result${total === 1 ? '' : 's'})`;
  $m('mergePrevPageBtn').disabled = mergeState.page <= 1;
  $m('mergeNextPageBtn').disabled = mergeState.page >= totalPages;
  document.querySelectorAll('.merge-page-size-btn').forEach((btn) => {
    const v = btn.dataset.size === 'all' ? 'all' : Number(btn.dataset.size);
    const active = v === mergeState.pageSize;
    btn.classList.toggle('btn--primary', active);
    btn.classList.toggle('btn--ghost', !active);
  });
}
document.querySelectorAll('.merge-page-size-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    mergeState.pageSize = btn.dataset.size === 'all' ? 'all' : Number(btn.dataset.size);
    mergeState.page = 1;
    mergeRenderResultsPage();
  });
});
$m('mergePrevPageBtn').addEventListener('click', () => {
  if (mergeState.page > 1) { mergeState.page--; mergeRenderResultsPage(); }
});
$m('mergeNextPageBtn').addEventListener('click', () => {
  mergeState.page++; mergeRenderResultsPage();
});

function mergeCurrentPageItems() {
  // Sorted the SAME way mergeRenderResultsPage itself does -- must match exactly, since this drives
  // the header checkbox's tri-state AND the shift-click range select (mergeApplyShiftRange indexes
  // into the live DOM rows, which are already in this same sorted order).
  const { pageItems } = mergePaginate(mergeSortedRows(mergeState.searchResults, mergeResultsSort));
  return pageItems;
}

function mergeUpdateHeaderCheckboxState() {
  const headerCb = $m('mergeHeaderCheckbox');
  const pageItems = mergeCurrentPageItems();
  const selectedCount = pageItems.filter((it) => mergeState.cart.has(MERGE_ITEM_KEY(it))).length;
  headerCb.checked = pageItems.length > 0 && selectedCount === pageItems.length;
  headerCb.indeterminate = selectedCount > 0 && selectedCount < pageItems.length;
}
$m('mergeHeaderCheckbox').addEventListener('change', (e) => {
  const checked = e.target.checked;
  for (const it of mergeCurrentPageItems()) mergeSetCartMembership(it, checked);
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeCheckSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});

function mergeUpdateSelectionCount() {
  const inThisSearch = mergeState.searchResults.filter((it) => mergeState.cart.has(MERGE_ITEM_KEY(it))).length;
  const total = mergeState.searchResults.length;
  $m('mergeSelectionCount').textContent = total ? `${inThisSearch} of ${total} in this search selected` : '';
}

$m('mergeSelectAllBtn').addEventListener('click', () => {
  for (const it of mergeState.searchResults) mergeSetCartMembership(it, true);
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeCheckSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});
$m('mergeInvertBtn').addEventListener('click', () => {
  for (const it of mergeState.searchResults) mergeSetCartMembership(it, !mergeState.cart.has(MERGE_ITEM_KEY(it)));
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeCheckSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});
$m('mergeClearSearchBtn').addEventListener('click', () => {
  for (const it of mergeState.searchResults) mergeSetCartMembership(it, false);
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeHideSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});
$m('mergeSelectAllBannerBtn').addEventListener('click', () => {
  for (const it of mergeState.searchResults) mergeSetCartMembership(it, true);
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeHideSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});

// Same Gmail/GitHub "select all M results?" pattern as Archive Finder's own results table --
// scoped here to "all M results IN THIS SEARCH", not the whole cart (the cart is a separate,
// longer-lived accumulation across many different searches).
function mergeCheckSelectAllBanner() {
  const total = mergeState.searchResults.length;
  const pageItems = mergeCurrentPageItems();
  const pageSelected = pageItems.filter((it) => mergeState.cart.has(MERGE_ITEM_KEY(it))).length;
  const allPageSelected = pageItems.length > 0 && pageSelected === pageItems.length;
  const allSelected = total > 0 && mergeState.searchResults.every((it) => mergeState.cart.has(MERGE_ITEM_KEY(it)));
  if (allPageSelected && total > pageItems.length && !allSelected) {
    $m('mergeSelectAllBannerPageCount').textContent = pageItems.length;
    $m('mergeSelectAllBannerTotalCount').textContent = total;
    $m('mergeSelectAllBanner').classList.remove('hidden');
  } else {
    mergeHideSelectAllBanner();
  }
}
function mergeHideSelectAllBanner() { $m('mergeSelectAllBanner').classList.add('hidden'); }

// ---------- The running cart + its own live "chosen" window ----------

function mergeUpdateCartBar() {
  const n = mergeState.cart.size;
  $m('mergeCartCount').textContent = n;
  $m('mergeCartCount2').textContent = n;
  $m('mergeStep1NextBtn').disabled = n === 0;
  $m('mergeStep1NextBtnTop').disabled = n === 0; // top-of-page twin, see mergeStep1BackBtnTop's own listener below
}

function mergeCartByCollection() {
  const groups = new Map(); // collectionName -> item[]
  for (const item of mergeState.cart.values()) {
    const list = groups.get(item.collectionName) || [];
    list.push(item);
    groups.set(item.collectionName, list);
  }
  return groups;
}

function mergeCartWindowBodyHtml() {
  const groups = mergeCartByCollection();
  if (mergeState.cart.size === 0) return '<p class="muted">Nothing chosen yet.</p>';
  let html = '';
  for (const [collectionName, items] of groups) {
    html += `<div class="settings-section-title" style="margin: 14px 0 4px;">${escMergeHtml(collectionName)} &middot; ${items.length}</div>`;
    html += items.map((item) => `<div class="merge-cart-row" data-key="${escMergeHtml(MERGE_ITEM_KEY(item))}"><span>${escMergeHtml(item.fileName)}${mergeMasterBadgeHtml(item.fileName)}</span><button class="af-tag-remove merge-cart-row__rm" title="Remove">×</button></div>`).join('');
  }
  return html;
}

function escMergeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Opens (or focuses, if already open) a genuine separate OS-level window listing the running cart,
// grouped by collection -- same mechanism rules-generator-app.js's rgOpenOldRulesWindow uses
// (window.open with explicit width/height, then document.write the shell directly, since there's
// no static URL for this client-only data). Kept open and updated LIVE as the cart changes
// (mergeRefreshCartWindow, called from every place that mutates the cart) rather than a one-shot
// snapshot -- the whole point of a real separate window per the build spec.
function mergeOpenCartWindow() {
  if (mergeCartWindow && !mergeCartWindow.closed) {
    mergeCartWindow.focus();
    mergeRefreshCartWindow();
    return;
  }
  const win = window.open('', '_blank', 'width=420,height=700');
  if (!win) return; // popup blocked -- nothing more we can do from here
  mergeCartWindow = win;
  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vortex Collection Tools &mdash; Chosen for merge</title>
<script>
  var t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
</script>
<link rel="stylesheet" href="/styles.css">
<style>
  body { padding: 18px 20px; }
  .merge-cart-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .merge-cart-row__rm { margin-left: auto; }
</style>
</head>
<body>
<h3 style="margin-top: 0;">🧬 Chosen for merge (<span id="mergeCartWinCount"></span>)</h3>
<div id="mergeCartWinBody"></div>
</body>
</html>`);
  win.document.close();
  win.addEventListener('click', (e) => {
    const rm = e.target.closest('.merge-cart-row__rm');
    if (!rm) return;
    const key = rm.closest('.merge-cart-row').dataset.key;
    mergeState.cart.delete(key);
    mergeRefreshRowsFromCart();
    mergeUpdateSelectionCount();
    mergeCheckSelectAllBanner();
    mergeUpdateCartBar();
    mergeRefreshCartWindow();
  });
  mergeRefreshCartWindow();
}
function mergeRefreshCartWindow() {
  if (!mergeCartWindow || mergeCartWindow.closed) return;
  const countEl = mergeCartWindow.document.getElementById('mergeCartWinCount');
  const bodyEl = mergeCartWindow.document.getElementById('mergeCartWinBody');
  if (countEl) countEl.textContent = mergeState.cart.size;
  if (bodyEl) bodyEl.innerHTML = mergeCartWindowBodyHtml();
}
$m('mergeViewCartBtn').addEventListener('click', mergeOpenCartWindow);

$m('mergeStep1BackBtn').addEventListener('click', () => mergeGoToStep(0));
$m('mergeStep1NextBtn').addEventListener('click', () => mergeGoToStep(2));
// Top-of-page twins in the sticky cart bar (merge-plugins-sticky-step-nav, 2026-08-17) -- same
// targets as the bottom pair above, just reachable without scrolling past a long results table.
$m('mergeStep1BackBtnTop').addEventListener('click', () => mergeGoToStep(0));
$m('mergeStep1NextBtnTop').addEventListener('click', () => mergeGoToStep(2));

// ---------- Step 2: review your merge ----------

async function mergeEnterStep2() {
  mergeHideError();
  $m('mergeReviewLoading').classList.remove('hidden');
  $m('mergeReviewBody').classList.add('hidden');
  $m('mergeStartBtn').disabled = true;
  const items = Array.from(mergeState.cart.values());
  try {
    const { results } = await mergeApi('POST', '/api/merge/analyze', { items });
    const byPath = new Map(results.map((r) => [r.fileName, r]));
    mergeState.reviewItems = items.map((item) => {
      const info = byPath.get(item.fileName) || {};
      // 'override' is informational only (2026-08-17) -- overriding plugins merge just like any
      // other now, see lib/merge-worker.js's runMerge for why "contains overrides" stopped meaning
      // "can't be merged". Priority unchanged from before: an item with both overrides AND its own
      // declared masters still shows as 'override' first (the more specific/interesting fact).
      let status;
      if (info.containsOverrides) status = 'override';
      else if ((info.masters || []).length > 0) status = 'master';
      else status = 'ok';
      return { ...item, ...info, status };
    });
    mergeRenderReviewStep();
  } catch (e) {
    $m('mergeReviewLoading').classList.add('hidden');
    mergeHandleError(e, mergeEnterStep2);
  }
}

function mergeReviewStatusPill(status, masters, overrideCount) {
  if (status === 'override') return `<span class="status-pill status-pill--warning" title="${overrideCount} record${overrideCount === 1 ? '' : 's'} change something in another plugin, which stays a required master">⚠️ Changes other records</span>`;
  if (status === 'master') return `<span class="status-pill status-pill--warning" title="Needs ${escMergeHtml(masters.join(', '))}">⚠️ Needs a master</span>`;
  return '<span class="muted">—</span>';
}

function mergeRenderReviewStep() {
  $m('mergeReviewLoading').classList.add('hidden');
  $m('mergeReviewBody').classList.remove('hidden');

  const items = mergeState.reviewItems;
  const included = items; // everything in the cart merges now -- 'override' no longer excludes (2026-08-17)
  const nMaster = items.filter((it) => it.status === 'master').length;
  const nOverride = items.filter((it) => it.status === 'override').length;
  const nClean = items.filter((it) => it.status === 'ok').length;

  $m('mergeReviewSub').textContent = `${items.length} plugin${items.length === 1 ? '' : 's'} chosen. Filter by status, drop anything that shouldn't go in, or go back to add more. None of these stop the merge — they're just heads-ups.`;

  const masterCallout = $m('mergeMasterCallout');
  if (nMaster > 0) {
    masterCallout.classList.remove('hidden');
    masterCallout.innerHTML = `<div class="callout__title">⚠️ ${nMaster} plugin${nMaster === 1 ? '' : 's'} depend${nMaster === 1 ? 's' : ''} on a master</div><p>Fine to merge — just make sure those masters are installed in Vortex. If one's missing after you install the merge, <strong>Missing Masters</strong> will catch it.</p>`;
  } else {
    masterCallout.classList.add('hidden');
  }

  // Informational only (2026-08-17) -- these plugins merge fine now, see
  // lib/merge-worker.js's runMerge for how their overrides carry over correctly.
  const overrideCallout = $m('mergeOverrideCallout');
  if (nOverride > 0) {
    overrideCallout.classList.remove('hidden');
    const overrideAreIs = nOverride === 1 ? 'is' : 'are';
    const overridePatchNoun = nOverride === 1 ? 'a patch' : 'patches';
    overrideCallout.innerHTML = `<div class="callout__title">⚠️ ${nOverride} of these ${overrideAreIs} ${overridePatchNoun}</div><p>Patches change records from other mods instead of only adding their own new content. That's fine — the merge keeps whatever plugin they change as a required master, so those changes still apply exactly like before.</p>`;
  } else {
    overrideCallout.classList.add('hidden');
  }

  const totalNewRecords = included.reduce((sum, it) => sum + (it.newRecordCount || 0), 0);
  const anyCellWorldspace = included.some((it) => it.hasCellOrWorldspace);
  const qualifies = included.length > 0 && totalNewRecords <= 4096 && !anyCellWorldspace;
  const eslCallout = $m('mergeEslCallout');
  if (included.length === 0) {
    eslCallout.classList.add('hidden');
  } else {
    eslCallout.classList.remove('hidden');
    if (qualifies) {
      eslCallout.innerHTML = `<div class="callout__title">🪶 This merge will be ESL-flagged — it won't cost a load-order slot</div><p>${totalNewRecords.toLocaleString()} new records (under the 4,096-record light-plugin limit) and no risky cell or worldspace edits — so it keeps its .esp name but loads as a light plugin (an "ESPFE"). Zero slots used.</p>`;
    } else {
      const reason = anyCellWorldspace
        ? 'It has cell or worldspace edits — too risky to flag as an ESL automatically'
        : `It has ${totalNewRecords.toLocaleString()} new records — over the 4,096 light-plugin limit`;
      eslCallout.innerHTML = `<div class="callout__title">This merge will stay a full .esp</div><p>${reason} — so it takes one load-order slot like a normal plugin.</p>`;
    }
  }

  // Drop any active filter status that no longer has a matching row (e.g. the last "Needs a
  // master" item got removed from the cart) -- same "stale filter" cleanup Rebuild Missing Files'
  // own rmfRenderRows does, per-key rather than clearing the whole filter.
  const presentStatuses = new Set(items.map((it) => it.status));
  for (const key of [...mergeReviewFilter]) {
    if (!presentStatuses.has(key)) mergeReviewFilter.delete(key);
  }
  const badgeActive = (status) => mergeReviewFilter.has(status) ? ' badge--filter-active' : '';
  $m('mergeReviewBadges').innerHTML = [
    `<span class="badge badge--neutral badge--show-all${mergeReviewFilter.size === 0 ? ' badge--filter-active' : ''}" data-status="all"><span class="badge__count">${items.length}</span> Show all</span>`,
    `<span class="badge badge--warning badge--clickable${badgeActive('master')}" data-status="master"><span class="badge__count">${nMaster}</span> ⚠️ Needs a master</span>`,
    `<span class="badge badge--warning badge--clickable${badgeActive('override')}" data-status="override"><span class="badge__count">${nOverride}</span> ⚠️ Changes other records</span>`,
    `<span class="badge badge--success badge--clickable${badgeActive('ok')}" data-status="ok"><span class="badge__count">${nClean}</span> Clean</span>`,
  ].join('');

  mergeRenderSortArrows(mergeReviewSort, { fileName: 'mergeReviewFileSortArrow', modName: 'mergeReviewModSortArrow' });
  const body = $m('mergeReviewTableBody');
  body.innerHTML = '';
  for (const item of mergeSortedRows(items, mergeReviewSort)) {
    const tr = el('tr', { 'data-status': item.status }, [
      el('td', {}, [item.fileName, mergeMasterBadge(item.fileName)]),
      el('td', { class: 'muted' }, item.modName),
      el('td', { class: 'muted' }, item.collectionName),
      el('td', { class: 'muted' }, String(item.recordCount ?? '—')),
    ]);
    const statusTd = document.createElement('td');
    statusTd.innerHTML = mergeReviewStatusPill(item.status, item.masters || [], item.overrideCount || 0);
    tr.appendChild(statusTd);
    const rmBtn = el('button', { class: 'af-tag-remove', title: 'Remove' }, '×');
    rmBtn.addEventListener('click', () => {
      mergeState.cart.delete(MERGE_ITEM_KEY(item));
      mergeState.reviewItems = mergeState.reviewItems.filter((r) => MERGE_ITEM_KEY(r) !== MERGE_ITEM_KEY(item));
      mergeUpdateCartBar();
      mergeRefreshCartWindow();
      mergeRenderReviewStep();
    });
    tr.appendChild(el('td', { style: 'text-align: right;' }, [rmBtn]));
    body.appendChild(tr);
  }
  document.querySelectorAll('#mergeReviewTableBody tr').forEach((tr) => {
    tr.classList.toggle('hidden', mergeReviewFilter.size > 0 && !mergeReviewFilter.has(tr.dataset.status));
  });

  $m('mergeOutputDirInput').value = mergeState.outputDir || '';
  mergeUpdateOutputPreview();
  $m('mergeStartBtn').disabled = included.length === 0;
  $m('mergeStartBtn').textContent = `Merge ${included.length} plugin${included.length === 1 ? '' : 's'} →`;
}

document.addEventListener('click', (e) => {
  const badge = e.target.closest('#mergeReviewBadges .badge');
  if (!badge) return;
  const status = badge.dataset.status;
  if (status === 'all') mergeReviewFilter.clear();
  else if (mergeReviewFilter.has(status)) mergeReviewFilter.delete(status);
  else mergeReviewFilter.add(status);
  document.querySelectorAll('#mergeReviewBadges .badge').forEach((b) => {
    b.classList.toggle('badge--filter-active', b.dataset.status === 'all' ? mergeReviewFilter.size === 0 : mergeReviewFilter.has(b.dataset.status));
  });
  document.querySelectorAll('#mergeReviewTableBody tr').forEach((tr) => {
    tr.classList.toggle('hidden', mergeReviewFilter.size > 0 && !mergeReviewFilter.has(tr.dataset.status));
  });
});

$m('mergeReviewFileHeader').addEventListener('click', () => mergeHandleHeaderSortClick(mergeReviewSort, 'fileName', mergeRenderReviewStep));
$m('mergeReviewModHeader').addEventListener('click', () => mergeHandleHeaderSortClick(mergeReviewSort, 'modName', mergeRenderReviewStep));

function mergeOutputFileName() {
  const raw = $m('mergeOutputNameInput').value.trim() || 'Merged Patch';
  return raw.toLowerCase().endsWith('.esp') ? raw : `${raw}.esp`;
}
function mergeUpdateOutputPreview() {
  const included = mergeState.reviewItems; // 'override' no longer excludes (2026-08-17)
  const totalNewRecords = included.reduce((sum, it) => sum + (it.newRecordCount || 0), 0);
  const anyCellWorldspace = included.some((it) => it.hasCellOrWorldspace);
  const qualifies = included.length > 0 && totalNewRecords <= 4096 && !anyCellWorldspace;
  $m('mergeResultPreview').textContent = `${mergeOutputFileName()} · ${qualifies ? 'ESL-flagged ✓' : 'Full ✓'}`;
}
$m('mergeOutputNameInput').addEventListener('input', mergeUpdateOutputPreview);
$m('mergeOutputBrowseBtn').addEventListener('click', async () => {
  try {
    const res = await mergeApi('POST', '/api/settings/browse-folder', { title: 'Choose where to save the merged plugin', initialDir: $m('mergeOutputDirInput').value.trim() || undefined });
    if (res.path) { $m('mergeOutputDirInput').value = res.path; mergeState.outputDir = res.path; }
  } catch (e) {
    mergeHandleError(e);
  }
});
$m('mergeOutputDirInput').addEventListener('input', () => { mergeState.outputDir = $m('mergeOutputDirInput').value.trim(); });

$m('mergeStep2BackBtn').addEventListener('click', () => mergeGoToStep(1));

// ---- Masters-dependency pre-flight check (2026-08-17) -- director's own real repro: merging a
// plugin other active plugins depend on as a master breaks them, and Merge Plugins used to just fail
// generically instead of warning first. zEdit/zMerge's own real dialog for this exact scenario is
// the direct precedent: "The following plugins will not be usable after building this merge. You
// can include them in the merge or remove the plugins they require from the merge to resolve this."
// ----

// Re-derives fresh right before a real build -- never trusts the boot-time cached snapshot
// (mergeState.masterDependents may already be populated from loadMergeOnBoot, but the real Data
// folder/Plugins.txt could have changed since then) -- same "always re-derive fresh before a real
// action" principle this whole app already follows elsewhere. Also refreshes the cached copy, so
// the "(master)" labels stay accurate too. Returns [] if nothing outside the merge set depends on
// anything actually going into it.
//
// Takes `items` (the plugins actually going into THIS build -- mergeStartMerge's own `included`,
// which as of 2026-08-17 is just reviewItems in full: 'override' no longer excludes anything, see
// runMerge's own header comment in lib/merge-worker.js). Kept as an explicit parameter rather than
// reading mergeState.reviewItems directly, since the exact "what's actually going into the build"
// set is exactly what this check needs to be scoped to -- if that set is ever narrowed again for
// some other reason in the future, this stays correct without another audit.
async function mergeCheckMasterDependencies(items) {
  const { dependents } = await mergeApi('GET', '/api/merge/master-dependents');
  mergeState.masterDependents = dependents || {};
  const cartFileNames = new Set(items.map((it) => it.fileName.toLowerCase()));
  const missing = new Map(); // dependent fileName (lowercased) -> {fileName, resolvedItem, neededFor: [masterFileName,...]}
  for (const item of items) {
    const deps = mergeState.masterDependents[item.fileName.toLowerCase()];
    if (!deps) continue;
    for (const dep of deps) {
      const depKey = dep.fileName.toLowerCase();
      if (cartFileNames.has(depKey)) continue; // already in the cart -- not a problem
      if (!missing.has(depKey)) missing.set(depKey, { ...dep, neededFor: [] });
      missing.get(depKey).neededFor.push(item.fileName);
    }
  }
  return [...missing.values()];
}

let mergePendingIncludeDependents = [];

// Serious register (TECHNICAL-FRIENDLY-VOICE-GUIDELINES.md) -- this is describing a real
// consequence (those plugins stop working), not just an FYI. Mirrors zEdit's own real warning
// wording closely, per the task's own instruction, adapted to this app's established modal shape.
function mergeOpenMasterDependencyModal(missing) {
  mergePendingIncludeDependents = missing.filter((m) => m.resolvedItem);
  const unresolvable = missing.filter((m) => !m.resolvedItem);

  const lines = missing.map((m) => {
    const note = m.resolvedItem ? '' : ' <span class="muted">(not found in any installed collection &mdash; can&rsquo;t be added automatically)</span>';
    return `<li><strong>${escMergeHtml(m.fileName)}</strong> &mdash; needs ${escMergeHtml(m.neededFor.join(', '))}${note}</li>`;
  }).join('');

  $m('mergeMasterDepModalText').innerHTML = `
    <p>The following plugin${missing.length === 1 ? '' : 's'} will not be usable after building this merge:</p>
    <ul>${lines}</ul>
    <p>You can include them in the merge, or cancel and remove the plugins they require from your selection instead.</p>
    ${unresolvable.length ? '<p class="muted">Plugins marked above as not found can\'t be added automatically -- cancel and remove what they require from your selection instead.</p>' : ''}`;
  $m('mergeMasterDepIncludeBtn').disabled = mergePendingIncludeDependents.length === 0;
  $m('mergeMasterDepModal').classList.remove('hidden');
}
$m('mergeMasterDepCancelBtn').addEventListener('click', () => {
  $m('mergeMasterDepModal').classList.add('hidden');
});
$m('mergeMasterDepIncludeBtn').addEventListener('click', async () => {
  $m('mergeMasterDepModal').classList.add('hidden');
  for (const dep of mergePendingIncludeDependents) mergeSetCartMembership(dep.resolvedItem, true);
  mergePendingIncludeDependents = [];
  mergeUpdateCartBar();
  mergeRefreshRowsFromCart();
  mergeRefreshCartWindow();
  await mergeEnterStep2(); // re-analyze so reviewItems reflects the newly-added plugins
  mergeStartMerge(); // re-run -- the check passes this time, since they're now in the cart
});

async function mergeStartMerge() {
  const included = mergeState.reviewItems; // 'override' no longer excludes (2026-08-17) -- everything in the cart goes into the build
  if (!included.length) return;
  const outputDir = $m('mergeOutputDirInput').value.trim();
  if (!outputDir) { mergeHandleError(new Error('Choose an output folder first.')); return; }

  try {
    const missingDependents = await mergeCheckMasterDependencies(included);
    if (missingDependents.length) {
      mergeOpenMasterDependencyModal(missingDependents);
      return;
    }
  } catch {
    // Non-fatal -- if the check itself can't run (e.g. Data folder unreadable), don't block the
    // whole merge over a heads-up feature; proceed as this always did before the check existed.
  }

  mergeProceedWithMerge(included, outputDir);
}
$m('mergeStartBtn').addEventListener('click', mergeStartMerge);

async function mergeProceedWithMerge(included, outputDir) {
  mergeGoToStep(3);
  $m('mergeProgressSub').innerHTML = `Building <strong>${mergeOutputFileName()}</strong> from ${included.length} plugin${included.length === 1 ? '' : 's'}. Vortex must stay closed while this runs.`;
  $m('mergeProgressBar').style.width = '0%';
  $m('mergeProgressText').textContent = 'Starting…';

  try {
    await mergeApi('POST', '/api/merge/merge', {
      items: included.map((it) => ({ fullPath: it.fullPath, fileName: it.fileName, modName: it.modName })),
      outputName: mergeOutputFileName(),
      outputDir,
    });
  } catch (e) {
    mergeGoToStep(2);
    mergeHandleError(e, mergeStartMerge);
    return;
  }

  if (mergeEventSource) mergeEventSource.close();
  const es = new EventSource('/api/merge/merge/events');
  mergeEventSource = es;
  es.onmessage = (msg) => mergeHandleProgressEvent(JSON.parse(msg.data), included);
}

// ---------- Step 3: merging progress (SSE) ----------

function mergeHandleProgressEvent(frame, included) {
  if (frame.type === 'progress') {
    const pct = frame.total ? Math.round((frame.current / frame.total) * 100) : 0;
    $m('mergeProgressBar').style.width = pct + '%';
    $m('mergeProgressText').textContent = `${frame.label || ''} (${frame.current} of ${frame.total})`;
  } else if (frame.type === 'done') {
    $m('mergeProgressBar').style.width = '100%';
    if (mergeEventSource) { mergeEventSource.close(); mergeEventSource = null; }
    mergeRenderDoneStep(frame, included);
    mergeGoToStep(4);
    mergeState.cart.clear();
    mergeState.reviewItems = [];
  } else if (frame.type === 'error') {
    if (mergeEventSource) { mergeEventSource.close(); mergeEventSource = null; }
    mergeGoToStep(2);
    mergeHandleError(new Error(frame.message || 'The merge failed.'));
  }
}

// ---------- Step 4: done ----------

let mergeLastOutputDir = '';
function mergeRenderDoneStep(result, included) {
  const modNames = new Set(included.map((it) => it.modName));
  const collectionNames = new Set(included.map((it) => it.collectionName));
  mergeLastOutputDir = result.outputPath.slice(0, Math.max(result.outputPath.lastIndexOf('\\'), result.outputPath.lastIndexOf('/')));

  $m('mergeDoneStats').innerHTML = [
    [included.length, `plugin${included.length === 1 ? '' : 's'} merged`],
    [modNames.size, `mod${modNames.size === 1 ? '' : 's'}`],
    [collectionNames.size, `collection${collectionNames.size === 1 ? '' : 's'}`],
    [result.recordCount, 'records'],
  ].map(([n, label]) => `<div class="merge-stat"><div class="merge-stat__n">${n.toLocaleString()}</div><div class="merge-stat__l">${label}</div></div>`).join('');

  const outFile = mergeOutputFileName();
  const eslCallout = $m('mergeDoneEslCallout');
  eslCallout.classList.remove('hidden');
  if (result.eslFlagged) {
    eslCallout.innerHTML = `<div class="callout__title">🧬 ${escMergeHtml(outFile)} created — ESL-flagged</div><p>Saved to <code>${escMergeHtml(result.outputPath)}</code>. Because it's light-flagged, it costs <strong>0</strong> of your 254 load-order slots — you just freed up the ones its originals were using.</p>`;
  } else {
    eslCallout.innerHTML = `<div class="callout__title">🧬 ${escMergeHtml(outFile)} created</div><p>Saved to <code>${escMergeHtml(result.outputPath)}</code>. It's a full .esp, so it takes one of your 254 load-order slots.</p>`;
  }
  $m('mergeDoneNextStepsText').innerHTML = `Install <strong>${escMergeHtml(outFile)}</strong> as a mod in Vortex and enable it, then disable the ${included.length} original${included.length === 1 ? '' : 's'} it replaces &mdash; same as adding a Dummy Master or DynDOLOD output.`;

  // textContent, not innerHTML -- logContent is plain text from lib/merge-worker.js's buildMergeLog
  // (real plugin/mod names embedded in it, never sanitized for HTML).
  const logDetails = $m('mergeDoneLogDetails');
  if (result.logContent) {
    $m('mergeDoneLogContent').textContent = result.logContent;
    logDetails.classList.remove('hidden');
    logDetails.open = false;
  } else {
    logDetails.classList.add('hidden');
  }

  mergeRenderRelinkSection(result, included.length);
}

// Relink Scripts (2026-08-18) -- web/merge-routes.js's own /merge success handler already ran the
// scan automatically (result.relinkCandidates), so this is purely about DISPLAYING what it already
// found and, if the user clicks through, running the actual relink against those SAME entries --
// never re-scans. mergePendingRelink holds everything the click handler needs (the merge's own
// mergeDataDir for map.json, the output folder, the merged plugin's own filename, and the entries
// themselves) since none of that is derivable from the DOM alone.
let mergePendingRelink = null;
function mergeRenderRelinkSection(result, mergedPluginCount) {
  const noneEl = $m('mergeDoneRelinkNone');
  const callout = $m('mergeDoneRelinkCallout');
  $m('mergeRelinkResult').classList.add('hidden');
  $m('mergeRelinkResult').innerHTML = '';
  $m('mergeRelinkScriptsBtn').classList.remove('hidden');
  $m('mergeRelinkScriptsBtn').disabled = false;

  const candidates = result.relinkCandidates || [];
  if (result.relinkScanError || !result.mergeDataDir) {
    noneEl.classList.add('hidden');
    callout.classList.add('hidden');
    return;
  }
  if (candidates.length === 0) {
    noneEl.classList.remove('hidden');
    callout.classList.add('hidden');
    mergePendingRelink = null;
    return;
  }
  noneEl.classList.add('hidden');
  callout.classList.remove('hidden');
  $m('mergeDoneRelinkTitle').textContent = `⚠️ ${candidates.length} script${candidates.length === 1 ? '' : 's'} reference${candidates.length === 1 ? 's' : ''} what you just merged`;
  $m('mergeDoneRelinkText').innerHTML = `These Papyrus scripts still point at the original plugin${mergedPluginCount === 1 ? '' : 's'} you just merged. Once you disable those originals, the scripts will look for content that is no longer there. Relink Scripts rewrites copies of them to point at <strong>${escMergeHtml(result.mergedPluginFileName)}</strong> instead and saves those copies separately -- it never changes your original scripts.`;
  mergePendingRelink = {
    entries: candidates,
    mergeDataDir: result.mergeDataDir,
    outputDir: mergeLastOutputDir,
    mergedPluginFileName: result.mergedPluginFileName,
  };
}

$m('mergeRelinkScriptsBtn').addEventListener('click', async () => {
  if (!mergePendingRelink) return;
  const btn = $m('mergeRelinkScriptsBtn');
  btn.disabled = true;
  const resultEl = $m('mergeRelinkResult');
  resultEl.classList.remove('hidden');
  resultEl.textContent = 'Relinking…';
  try {
    const result = await mergeApi('POST', '/api/merge/relink', mergePendingRelink);
    const lines = [];
    if (result.relinked.length) lines.push(`<p>Relinked ${result.relinked.length} script${result.relinked.length === 1 ? '' : 's'}. Saved to <code>${escMergeHtml(result.outputDir)}</code> -- install these in place of the originals, the same way you install the merged plugin itself.</p>`);
    if (result.failed.length) {
      lines.push(`<p>Could not relink ${result.failed.length} script${result.failed.length === 1 ? '' : 's'}:</p><ul>${result.failed.map((f) => `<li>${escMergeHtml(f.filename)} -- ${escMergeHtml(f.message)}</li>`).join('')}</ul>`);
    }
    resultEl.innerHTML = lines.join('') || '<p>Nothing was relinked.</p>';
    btn.classList.add('hidden');
  } catch (e) {
    resultEl.textContent = '';
    mergeHandleError(e);
    btn.disabled = false;
  }
});

$m('mergeOpenOutputBtn').addEventListener('click', async () => {
  try {
    await mergeApi('POST', '/api/merge/open-output-folder', { folderPath: mergeLastOutputDir });
  } catch (e) {
    mergeHandleError(e);
  }
});
$m('mergeAnotherBtn').addEventListener('click', () => {
  mergeState.searchResults = [];
  $m('mergeSearchInput').value = '';
  mergeGoToStep(0);
});

// ---------- Init ----------

mergeRenderStepper();
loadMergeOnBoot();
