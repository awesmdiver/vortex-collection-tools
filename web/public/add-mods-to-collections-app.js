'use strict';
// Bulk Collection Editor (Utilities area) -- front end. Real logic lives in
// lib/add-mods-to-collections.js; this file only renders what the API returns. Reference mockups:
// design/mockup-remove-mods-from-collections.html (current, collections-first, both jobs) and
// design/mockup-add-mods-to-collections.html (the original Add-only search mechanics, still
// accurate for that half). Own tiny $amc()/amcApi() helpers, same "self-contained area" convention
// as every other *-app.js file here. Reuses el() from cleanup-app.js (already loaded first) for DOM
// building.
//
// REWRITTEN 2026-09-15 ("add and remove mods across collections, collections-first"): both jobs now
// run Collections -> Mods -> Done (Add used to run mod-search -> collections -> done). A mode switch
// (Add mods / Remove mods) sits above every step; switching modes always restarts at Step 1, since
// Step 2 shows a completely different list per mode -- there's no sane partial state to carry across.

function $amc(id) { return document.getElementById(id); }

async function amcApi(method, path, body) {
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

// Same shared-modal error handling every other Vortex-gated tool in this app already uses
// (isServerUnreachableError/showServerUnreachableError/showHelperUnavailableModal -- defined in
// shell.js, loaded before this file). This tool is Helper-only (no state.v2 fallback -- see
// lib/add-mods-to-collections.js's own header comment), so helper-unavailable is the one real gate.
function amcHandleError(e, retryFn) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(retryFn || (() => {}));
    return;
  }
  if (e.status === 409 && e.body?.error === 'helper-unavailable') {
    window.showHelperUnavailableModal(retryFn || (() => {}));
    return;
  }
  const box = $amc('amcCriticalError');
  box.textContent = '';
  box.appendChild(el('div', { class: 'callout__title' }, "🛑 Couldn't do that"));
  box.appendChild(el('p', {}, e.message));
  box.classList.remove('hidden');
}
function amcHideError() {
  $amc('amcCriticalError').classList.add('hidden');
  $amc('amcCriticalError').innerHTML = '';
}

// Singular/plural helper -- every count in this tool's own copy needs to read right ("1 mod from 1
// collection", never "1 mods from 1 collections"; confirmed real, the Gemini copy pass flagged this
// specifically).
function amcPlural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

const AMC_STEPS = ['Collections', 'Mods', 'Done'];
const amcState = {
  step: 0,
  mode: 'add', // 'add' | 'remove'
  collections: [], // every editable collection: {modId, name, modCount, version, revisionNumber}
  collSelected: new Set(), // picked collection modIds (Step 1)

  // Add mode:
  searchResults: [], // the CURRENT search's hits: {modId, name, version, alreadyIn}
  picked: new Map(), // modId -> {modId, name, version} -- accumulates across every search, never
  // reset by a new one (same "running cart" idea as Merge Plugins' own mergeState.cart).

  // Remove mode:
  removeMods: [], // the merged list: {modId, name, version, inCollections}
  removeSelected: new Set(), // modIds checked for removal
  removeFilter: '',
};
let amcLastClickedCheckbox = null; // shift-click range select, whichever results table is showing

// ---------- Mode switch ----------

function amcRenderModeSwitch() {
  $amc('amcModeAddBtn').classList.toggle('is-on', amcState.mode === 'add');
  $amc('amcModeRemoveBtn').classList.toggle('is-on-danger', amcState.mode === 'remove');
}

function amcSetMode(mode) {
  if (amcState.mode === mode) return;
  amcState.mode = mode;
  amcState.searchResults = [];
  amcState.picked.clear();
  amcState.removeMods = [];
  amcState.removeSelected.clear();
  amcState.removeFilter = '';
  $amc('amcRemoveFilterInput').value = '';
  amcRenderModeSwitch();
  amcGoToStep(0);
}
$amc('amcModeAddBtn').addEventListener('click', () => amcSetMode('add'));
$amc('amcModeRemoveBtn').addEventListener('click', () => amcSetMode('remove'));

// ---------- Stepper + navigation ----------

function amcRenderStepper() {
  $amc('amcStepper').innerHTML = AMC_STEPS.map((label, i) => {
    const cls = i < amcState.step ? 'done' : i === amcState.step ? 'active' : '';
    const num = i < amcState.step ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}

function amcGoToStep(n) {
  amcState.step = n;
  amcRenderStepper();
  for (let i = 0; i < 3; i++) $amc(`amcStep${i}`).classList.toggle('hidden', i !== n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (n === 0) amcEnterStep0();
  if (n === 1) amcEnterStep1();
}

// Full reset to Step 1 (Collections), clearing every pick -- called both by "Edit more collections"
// (Step 3) and by cleanup-app.js's showUtilitiesSubTab whenever arriving here from a DIFFERENT
// sub-tab (same previousSubTab-guarded convention every other multi-step Utilities tool already
// follows). Always resets to Add mode -- "starts fresh" per every other Utilities tool's own
// re-entry convention, not whatever mode was last left in.
function amcResetOnEntry() {
  amcHideError();
  amcState.mode = 'add';
  amcState.searchResults = [];
  amcState.picked.clear();
  amcState.removeMods = [];
  amcState.removeSelected.clear();
  amcState.removeFilter = '';
  amcState.collSelected.clear();
  $amc('amcSearchInput').value = '';
  $amc('amcRemoveFilterInput').value = '';
  $amc('amcSearchResultsWrap').classList.add('hidden');
  $amc('amcSearchEmpty').classList.add('hidden');
  amcRenderModeSwitch();
  amcRenderPicked();
  amcGoToStep(0);
}
window.amcResetOnEntry = amcResetOnEntry;

// ---------- Step 1: pick collections (both modes) ----------

function amcCollectionCard(c) {
  const checkbox = el('input', { type: 'checkbox' });
  checkbox.checked = amcState.collSelected.has(c.modId);
  const revText = c.revisionNumber ? `published Rev ${c.revisionNumber}` : 'not published yet';
  const card = el('label', { class: checkbox.checked ? 'coll-card sel' : 'coll-card' }, [
    checkbox,
    el('div', { class: 'meta' }, [
      el('div', { class: 'name' }, c.name),
      el('div', { class: 'sub' }, [
        `${amcPlural(c.modCount, 'mod')} · v${c.version} ·`,
        el('span', { class: 'rev' }, revText),
      ]),
    ]),
  ]);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) amcState.collSelected.add(c.modId);
    else amcState.collSelected.delete(c.modId);
    card.classList.toggle('sel', checkbox.checked);
    amcRenderCollSelCount();
  });
  return card;
}

function amcRenderCollections() {
  const grid = $amc('amcCollGrid');
  grid.innerHTML = '';
  if (amcState.collections.length === 0) {
    $amc('amcCollWrap').classList.add('hidden');
    $amc('amcCollEmpty').textContent = "You don't have any collections you can edit yet -- create one in Vortex first.";
    $amc('amcCollEmpty').classList.remove('hidden');
    return;
  }
  $amc('amcCollEmpty').classList.add('hidden');
  $amc('amcCollWrap').classList.remove('hidden');
  for (const c of amcState.collections) grid.appendChild(amcCollectionCard(c));
  amcRenderCollSelCount();
}

function amcRenderCollSelCount() {
  const n = amcState.collSelected.size;
  const m = amcState.collections.length;
  $amc('amcCollSelCount').textContent = m ? `${n} of ${m} selected` : '';
  $amc('amcCollNextBtn').disabled = n === 0;
}

$amc('amcCollSelectAllBtn').addEventListener('click', () => {
  amcState.collSelected = new Set(amcState.collections.map((c) => c.modId));
  amcRenderCollections();
});
$amc('amcCollInvertBtn').addEventListener('click', () => {
  const next = new Set();
  for (const c of amcState.collections) if (!amcState.collSelected.has(c.modId)) next.add(c.modId);
  amcState.collSelected = next;
  amcRenderCollections();
});
$amc('amcCollClearBtn').addEventListener('click', () => {
  amcState.collSelected.clear();
  amcRenderCollections();
});

// Re-fetched every visit, never cached -- which collections exist (and are editable) can change any
// time Vortex is used, same "state changes constantly" reasoning Clear Update Flags' own
// runClearUpdateFlagsList already follows.
async function amcEnterStep0() {
  amcHideError();
  $amc('amcCollLoading').classList.remove('hidden');
  $amc('amcCollWrap').classList.add('hidden');
  $amc('amcCollEmpty').classList.add('hidden');
  try {
    const data = await amcApi('GET', '/api/add-mods-to-collections/collections');
    amcState.collections = data.collections || [];
    // A collection unchecked since a previous visit (or one that's vanished from live state) is
    // dropped from the selection rather than left dangling.
    const stillThere = new Set(amcState.collections.map((c) => c.modId));
    for (const id of [...amcState.collSelected]) if (!stillThere.has(id)) amcState.collSelected.delete(id);
    amcRenderCollections();
  } catch (e) {
    amcHandleError(e, amcEnterStep0);
  } finally {
    $amc('amcCollLoading').classList.add('hidden');
  }
}

function amcPickedCollectionEntries() {
  return amcState.collections.filter((c) => amcState.collSelected.has(c.modId)).map((c) => ({ modId: c.modId, name: c.name, version: c.version }));
}
function amcCollectionNamesJoined() {
  const names = amcPickedCollectionEntries().map((c) => c.name);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

$amc('amcCollNextBtn').addEventListener('click', () => amcGoToStep(1));

// ---------- Step 2: mods (Add sub-view) ----------

function amcRowKey(item) { return item.modId; }

function amcAlreadyInCell(alreadyIn) {
  if (!alreadyIn || alreadyIn.length === 0) return el('span', { class: 'muted' }, '—');
  return el('span', {}, alreadyIn.map((c) => el('span', { class: 'status-pill status-pill--version' }, [c.name, el('span', { class: 'rev' }, `v${c.version}`)])));
}

function amcRenderSearchResults() {
  const wrap = $amc('amcSearchResultsWrap');
  const empty = $amc('amcSearchEmpty');
  if (amcState.searchResults.length === 0) {
    wrap.classList.add('hidden');
    empty.textContent = 'No installed mods match that search.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  wrap.classList.remove('hidden');
  const tbody = $amc('amcSearchResultsBody');
  tbody.innerHTML = '';
  for (const item of amcState.searchResults) {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = amcState.picked.has(amcRowKey(item));
    const tr = el('tr', {}, [
      el('td', { class: 'col-check' }, [checkbox]),
      el('td', {}, item.name),
      el('td', { style: 'text-align:right' }, item.version || '—'),
      el('td', {}, [amcAlreadyInCell(item.alreadyIn)]),
    ]);
    tr.dataset.key = amcRowKey(item);
    tr.classList.toggle('selected', checkbox.checked);
    checkbox.addEventListener('click', (e) => {
      if (e.shiftKey && amcLastClickedCheckbox && amcLastClickedCheckbox !== checkbox) {
        amcApplyShiftRange('#amcSearchResultsBody', amcLastClickedCheckbox, checkbox, checkbox.checked);
      }
      amcLastClickedCheckbox = checkbox;
    });
    checkbox.addEventListener('change', () => {
      amcSetPicked(item, checkbox.checked);
      tr.classList.toggle('selected', checkbox.checked);
      amcRenderSearchSelCount();
      amcRenderPicked();
    });
    tbody.appendChild(tr);
  }
  amcRenderSearchSelCount();
}

function amcApplyShiftRange(bodySelector, fromCb, toCb, checked) {
  const all = Array.from(document.querySelectorAll(`${bodySelector} input[type=checkbox]`));
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

function amcSetPicked(item, on) {
  const key = amcRowKey(item);
  if (on) amcState.picked.set(key, item);
  else amcState.picked.delete(key);
}

function amcRenderSearchSelCount() {
  const total = amcState.searchResults.length;
  const n = amcState.searchResults.filter((item) => amcState.picked.has(amcRowKey(item))).length;
  $amc('amcSearchSelCount').textContent = total ? `${n} of ${total} selected` : '';
}

function amcRenderPicked() {
  $amc('amcPickedCount').textContent = amcState.picked.size;
  const list = $amc('amcPickedList');
  list.innerHTML = '';
  if (amcState.picked.size === 0) {
    list.appendChild(el('li', { class: 'muted', style: 'border-bottom:none' }, 'Nothing picked yet — check a mod above.'));
  } else {
    for (const item of amcState.picked.values()) {
      list.appendChild(el('li', {}, [el('span', {}, item.name), el('span', { class: 'v' }, item.version || '')]));
    }
  }
  amcRenderAddBtn();
}

function amcRenderAddBtn() {
  const n = amcState.collSelected.size;
  $amc('amcAddBtn').textContent = `Add to ${amcPlural(n, 'collection')}`;
  $amc('amcAddBtn').disabled = amcState.picked.size === 0 || n === 0;
}

async function amcRunSearch() {
  amcHideError();
  const q = $amc('amcSearchInput').value.trim();
  if (!q) {
    amcState.searchResults = [];
    amcRenderSearchResults();
    return;
  }
  $amc('amcSearchLoading').classList.remove('hidden');
  $amc('amcSearchResultsWrap').classList.add('hidden');
  $amc('amcSearchEmpty').classList.add('hidden');
  try {
    const data = await amcApi('POST', '/api/add-mods-to-collections/search', { q, collections: amcPickedCollectionEntries() });
    amcState.searchResults = data.results || [];
    amcRenderSearchResults();
  } catch (e) {
    amcHandleError(e, amcRunSearch);
  } finally {
    $amc('amcSearchLoading').classList.add('hidden');
  }
}
$amc('amcSearchBtn').addEventListener('click', amcRunSearch);
$amc('amcSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') amcRunSearch(); });

$amc('amcSelectAllBtn').addEventListener('click', () => {
  for (const item of amcState.searchResults) amcSetPicked(item, true);
  amcRenderSearchResults();
  amcRenderPicked();
});
$amc('amcInvertBtn').addEventListener('click', () => {
  for (const item of amcState.searchResults) amcSetPicked(item, !amcState.picked.has(amcRowKey(item)));
  amcRenderSearchResults();
  amcRenderPicked();
});
$amc('amcClearBtn').addEventListener('click', () => {
  for (const item of amcState.searchResults) amcSetPicked(item, false);
  amcRenderSearchResults();
  amcRenderPicked();
});

async function amcSubmitAdd() {
  amcHideError();
  $amc('amcStep1Body').classList.add('hidden');
  $amc('amcProgressText').textContent = 'Adding your mods to those collections…';
  $amc('amcAddProgress').classList.remove('hidden');
  const modIds = Array.from(amcState.picked.keys());
  const collections = amcPickedCollectionEntries();
  try {
    const result = await amcApi('POST', '/api/add-mods-to-collections/add', { modIds, collections });
    amcRenderAddDone(result, modIds.length);
    amcGoToStep(2);
  } catch (e) {
    $amc('amcStep1Body').classList.remove('hidden');
    $amc('amcAddProgress').classList.add('hidden');
    amcHandleError(e, amcSubmitAdd);
  }
}
$amc('amcAddBtn').addEventListener('click', amcSubmitAdd);
$amc('amcStep1BackBtn').addEventListener('click', () => amcGoToStep(0));

// ---------- Step 2: mods (Remove sub-view) ----------

function amcInCollectionsCell(inCollections) {
  return el('span', {}, inCollections.map((c) => el('span', { class: 'status-pill status-pill--version' }, [c.name, el('span', { class: 'rev' }, `v${c.version}`)])));
}

function amcVisibleRemoveMods() {
  const q = amcState.removeFilter.trim().toLowerCase();
  if (!q) return amcState.removeMods;
  return amcState.removeMods.filter((m) => m.name.toLowerCase().includes(q));
}

function amcRenderRemoveResults() {
  const visible = amcVisibleRemoveMods();
  const wrap = $amc('amcRemoveWrap');
  const empty = $amc('amcRemoveEmpty');
  if (amcState.removeMods.length === 0) {
    wrap.classList.add('hidden');
    empty.textContent = 'None of the picked collections have any mods in them.';
    empty.classList.remove('hidden');
    return;
  }
  if (visible.length === 0) {
    wrap.classList.add('hidden');
    empty.textContent = 'No mod in these collections matches that filter.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  wrap.classList.remove('hidden');
  const tbody = $amc('amcRemoveResultsBody');
  tbody.innerHTML = '';
  for (const item of visible) {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = amcState.removeSelected.has(item.modId);
    const tr = el('tr', {}, [
      el('td', { class: 'col-check' }, [checkbox]),
      el('td', {}, item.name),
      el('td', { style: 'text-align:right' }, item.version || '—'),
      el('td', {}, [amcInCollectionsCell(item.inCollections)]),
    ]);
    tr.dataset.key = item.modId;
    tr.classList.toggle('selected', checkbox.checked);
    checkbox.addEventListener('click', (e) => {
      if (e.shiftKey && amcLastClickedCheckbox && amcLastClickedCheckbox !== checkbox) {
        amcApplyShiftRange('#amcRemoveResultsBody', amcLastClickedCheckbox, checkbox, checkbox.checked);
      }
      amcLastClickedCheckbox = checkbox;
    });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) amcState.removeSelected.add(item.modId);
      else amcState.removeSelected.delete(item.modId);
      tr.classList.toggle('selected', checkbox.checked);
      amcRenderRemoveSelCount();
    });
    tbody.appendChild(tr);
  }
  amcRenderRemoveSelCount();
}

function amcRenderRemoveSelCount() {
  const total = amcVisibleRemoveMods().length;
  const n = amcState.removeSelected.size;
  $amc('amcRemoveSelCount').textContent = amcState.removeMods.length ? `${n} of ${amcState.removeMods.length} selected${total !== amcState.removeMods.length ? ` (${total} shown)` : ''}` : '';
  $amc('amcRemoveBtn').textContent = `Remove from ${amcPlural(amcState.collSelected.size, 'collection')}`;
  $amc('amcRemoveBtn').disabled = n === 0;
}

$amc('amcRemoveFilterInput').addEventListener('input', () => {
  amcState.removeFilter = $amc('amcRemoveFilterInput').value;
  amcRenderRemoveResults();
});
$amc('amcRemoveSelectAllBtn').addEventListener('click', () => {
  for (const item of amcVisibleRemoveMods()) amcState.removeSelected.add(item.modId);
  amcRenderRemoveResults();
});
$amc('amcRemoveInvertBtn').addEventListener('click', () => {
  for (const item of amcVisibleRemoveMods()) {
    if (amcState.removeSelected.has(item.modId)) amcState.removeSelected.delete(item.modId);
    else amcState.removeSelected.add(item.modId);
  }
  amcRenderRemoveResults();
});
$amc('amcRemoveClearBtn').addEventListener('click', () => {
  for (const item of amcVisibleRemoveMods()) amcState.removeSelected.delete(item.modId);
  amcRenderRemoveResults();
});
$amc('amcRemoveBackBtn').addEventListener('click', () => amcGoToStep(0));

async function amcLoadRemoveMods() {
  $amc('amcRemoveLoading').classList.remove('hidden');
  $amc('amcRemoveWrap').classList.add('hidden');
  $amc('amcRemoveEmpty').classList.add('hidden');
  try {
    const data = await amcApi('POST', '/api/add-mods-to-collections/mods-in-collections', { collections: amcPickedCollectionEntries() });
    amcState.removeMods = data.mods || [];
    const stillThere = new Set(amcState.removeMods.map((m) => m.modId));
    for (const id of [...amcState.removeSelected]) if (!stillThere.has(id)) amcState.removeSelected.delete(id);
    amcRenderRemoveResults();
  } catch (e) {
    amcHandleError(e, amcLoadRemoveMods);
  } finally {
    $amc('amcRemoveLoading').classList.add('hidden');
  }
}

function amcShowRemoveConfirm() {
  const n = amcState.removeSelected.size;
  const m = amcState.collSelected.size;
  $amc('amcRemoveConfirmTitle').textContent = `Remove ${amcPlural(n, 'mod')} from ${amcPlural(m, 'collection')}?`;
  $amc('amcRemoveConfirmText').textContent = "This only updates your collection lists in Vortex — it won't uninstall anything or touch your files.";
  $amc('amcRemoveConfirmModal').classList.remove('hidden');
}
$amc('amcRemoveBtn').addEventListener('click', amcShowRemoveConfirm);
$amc('amcRemoveConfirmCancelBtn').addEventListener('click', () => $amc('amcRemoveConfirmModal').classList.add('hidden'));
$amc('amcRemoveConfirmOkBtn').addEventListener('click', async () => {
  $amc('amcRemoveConfirmModal').classList.add('hidden');
  amcHideError();
  $amc('amcStep1Body').classList.add('hidden');
  $amc('amcProgressText').textContent = 'Removing those mods from those collections…';
  $amc('amcAddProgress').classList.remove('hidden');
  const modIds = Array.from(amcState.removeSelected);
  const collections = amcPickedCollectionEntries();
  try {
    const result = await amcApi('POST', '/api/add-mods-to-collections/remove', { modIds, collections });
    amcRenderRemoveDone(result, modIds.length);
    amcGoToStep(2);
  } catch (e) {
    $amc('amcStep1Body').classList.remove('hidden');
    $amc('amcAddProgress').classList.add('hidden');
    amcHandleError(e, () => {});
  }
});

// ---------- Step 2 entry (shared) ----------

function amcEnterStep1() {
  amcHideError();
  $amc('amcStep1Body').classList.remove('hidden');
  $amc('amcAddProgress').classList.add('hidden');
  const names = amcCollectionNamesJoined();
  if (amcState.mode === 'add') {
    $amc('amcModsTitle').textContent = `Select mods to add to ${names}`;
    $amc('amcAddView').classList.remove('hidden');
    $amc('amcRemoveView').classList.add('hidden');
    amcRenderAddBtn();
    amcRenderPicked();
  } else {
    $amc('amcModsTitle').textContent = `Select mods to remove from ${names}`;
    $amc('amcAddView').classList.add('hidden');
    $amc('amcRemoveView').classList.remove('hidden');
    amcRenderRemoveSelCount();
    amcLoadRemoveMods();
  }
}

// ---------- Step 3: Done ----------

// One row per collection, the app's own ▶/▼ expand pattern (matching work-through-app.js's own
// mhExpandedMerges-style toggle rather than the mockup's literal <details> markup -- this project's
// established convention for "expand a group" is a plain JS-managed Set + re-render, not a native
// <details> element). First group open, rest collapsed -- exactly the mockup's own default.
const amcExpandedDoneGroups = new Set();

function amcResultGroupRow(collection, mode) {
  const isExpanded = amcExpandedDoneGroups.has(collection.modId);
  // version/revisionNumber come from Step 1's own already-fetched amcState.collections, not from
  // this write's own result entry (addModsToCollections/removeModsFromCollections only ever echo
  // back {modId, name} for display -- they were never asked to carry version/revisionNumber too,
  // and re-deriving it from data already on hand avoids a second server round trip just for that).
  const original = amcState.collections.find((c) => c.modId === collection.modId);
  const version = original ? original.version : '?';
  const revisionNumber = original ? original.revisionNumber : null;
  const revText = revisionNumber ? `published Rev ${revisionNumber}` : 'not published yet';
  const count = mode === 'add'
    ? amcPlural(collection.added, 'mod') + ' added'
    : amcPlural(collection.removed, 'mod') + ' removed';
  const header = el('div', { class: 'muted', style: 'display:flex; align-items:center; gap:10px; cursor:pointer;' }, [
    el('span', {}, isExpanded ? '▼' : '▶'),
    el('strong', { style: 'color: var(--text);' }, collection.name),
    el('span', { class: 'rev' }, `v${version} · ${revText}`),
    el('span', { style: 'margin-left:auto' }, count),
  ]);
  header.addEventListener('click', () => {
    if (amcExpandedDoneGroups.has(collection.modId)) amcExpandedDoneGroups.delete(collection.modId);
    else amcExpandedDoneGroups.add(collection.modId);
    amcRenderDoneGroups(amcLastDoneResult, mode);
  });
  const card = el('div', { class: 'path-row', style: 'flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 10px;' }, [header]);
  if (collection.error) {
    card.appendChild(el('p', { class: 'muted', style: 'margin:0 0 0 24px; color: var(--danger);' }, `Couldn't check this collection: ${collection.error}`));
    return card;
  }
  if (!isExpanded) return card;
  if (mode === 'add') {
    const bits = [];
    if (collection.alreadyPresent > 0) bits.push(`${amcPlural(collection.alreadyPresent, 'mod')} already there`);
    if (collection.failed > 0) bits.push(`${amcPlural(collection.failed, 'mod')} failed`);
    if (bits.length > 0) card.appendChild(el('p', { class: 'muted', style: 'margin:0 0 0 24px' }, bits.join(', ')));
    return card;
  }
  // Remove mode: a small table of what came out, its version, and whether it's still in another of
  // your collections.
  if (collection.failed > 0) {
    card.appendChild(el('p', { class: 'muted', style: 'margin:0 0 0 24px; color: var(--warning);' }, `${amcPlural(collection.failed, 'mod')} failed to remove.`));
  }
  if (collection.removedMods.length === 0) return card;
  const table = el('table', { class: 'plan-table' }, [
    el('thead', {}, [el('tr', {}, [el('th', {}, 'Mod'), el('th', {}, 'Version'), el('th', {}, 'Still in')])]),
    el('tbody', {}, collection.removedMods.map((m) => el('tr', {}, [
      el('td', {}, m.name),
      el('td', {}, m.version || '—'),
      el('td', {}, m.stillIn.length === 0
        ? [el('span', { class: 'muted' }, 'no other collections')]
        : m.stillIn.map((c) => el('span', { class: 'status-pill status-pill--version' }, c.name))),
    ]))),
  ]);
  card.appendChild(el('div', { class: 'plan-table-wrap', style: 'margin:0 0 0 24px' }, [table]));
  return card;
}

let amcLastDoneResult = null;

function amcRenderDoneGroups(result, mode) {
  amcLastDoneResult = result;
  const container = $amc('amcDoneGroups');
  container.innerHTML = '';
  const collections = result.collections || [];
  for (const c of collections) container.appendChild(amcResultGroupRow(c, mode));
}

function amcOpenFirstDoneGroup(collections) {
  amcExpandedDoneGroups.clear();
  if (collections.length > 0) amcExpandedDoneGroups.add(collections[0].modId);
}

// `pickedCount`: the number of DISTINCT mods the user actually picked (amcState.picked.size at
// submit time) -- NOT the same number as result.totalAdded/totalRemoved, which sums each
// collection's own successful writes (one mod added to 2 collections counts as 2 there). The
// success-path headline uses pickedCount, matching the plain-English reading of "Added N mods to M
// collections" (N mods picked, not N writes performed); the partial-problem path keeps the server's
// own summed total, since "how many (mod, collection) writes actually went through" is exactly what
// that wording needs to report.
function amcRenderAddDone(result, pickedCount) {
  const collections = result.collections || [];
  amcOpenFirstDoneGroup(collections);
  const totalAdded = result.totalAdded || 0;
  const anyProblem = collections.some((c) => c.failed > 0 || c.error);

  const callout = $amc('amcDoneCallout');
  callout.classList.remove('callout--success', 'callout--warning');
  callout.classList.add(anyProblem ? 'callout--warning' : 'callout--success');
  $amc('amcDoneTitle').textContent = anyProblem ? '⚠️ Added with some problems' : '🎉 Collections updated!';
  $amc('amcDoneBody').textContent = anyProblem
    ? `Added ${amcPlural(totalAdded, 'mod')} across ${amcPlural(collections.length, 'collection')} — see below for what didn't go through.`
    : `Added ${amcPlural(pickedCount, 'mod')} to ${amcPlural(collections.length, 'collection')}.`;

  amcRenderDoneGroups(result, 'add');
}

function amcRenderRemoveDone(result, pickedCount) {
  const collections = result.collections || [];
  amcOpenFirstDoneGroup(collections);
  const totalRemoved = result.totalRemoved || 0;
  const anyProblem = collections.some((c) => c.failed > 0 || c.error);

  const callout = $amc('amcDoneCallout');
  callout.classList.remove('callout--success', 'callout--warning');
  callout.classList.add(anyProblem ? 'callout--warning' : 'callout--success');
  $amc('amcDoneTitle').textContent = anyProblem ? '⚠️ Removed with some problems' : '🎉 Collections updated!';
  $amc('amcDoneBody').textContent = anyProblem
    ? `Removed ${amcPlural(totalRemoved, 'mod')} across ${amcPlural(collections.length, 'collection')} — see below for what didn't go through.`
    : `Removed ${amcPlural(pickedCount, 'mod')} across ${amcPlural(collections.length, 'collection')}. Your mods are still installed — only the collection lists changed.`;

  amcRenderDoneGroups(result, 'remove');
}

$amc('amcStartOverBtn').addEventListener('click', () => amcResetOnEntry());

// Initial render so the stepper/mode switch show a sane empty state even before the tab is ever
// opened (same convention every other module-scoped *-app.js file here follows at load time).
amcRenderStepper();
amcRenderModeSwitch();
amcRenderPicked();
