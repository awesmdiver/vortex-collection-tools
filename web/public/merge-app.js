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
  collections: [], // EVERY pickable collection, installed + workshop combined (flat) -- selection/
  // counting/name-lookup logic doesn't care which section a collection came from, only rendering
  // does (see collectionsBySection below). Populated from collectionsBySection right after every
  // fetch, never independently.
  collectionsBySection: { installed: [], workshop: [] }, // 2026-08-27 -- the server's own real
  // Installed/Workshop split (lib/missing-files-scan.js's listPickableCollections), used only by
  // mergeRenderCollectionList to build the two labeled sections. mergeState.collections above is
  // the flat union of both, for everything else.
  collSelected: new Set(), // chosen modIds (Step 0) -- ONE set shared across both sections; nothing
  // about picking from either section needs to differ once both are visible and labeled.
  extensions: ['.esp', '.esl', '.esm'],
  searchResults: [], // the CURRENT search's full result set (flat, across all its pages)
  // Fingerprint (sorted, order-independent) of collSelected as of the last SUCCESSFUL search
  // (2026-08-24, merge-step1-stale-search-fix) -- null until the first search ever completes. See
  // mergeEnterStep1's own comment for the real bug this fixes: re-entering Step 1 after changing
  // Step 0's selection used to skip re-searching whenever searchResults was already non-empty,
  // silently showing the PREVIOUS collection's stale plugin list under the new selection's own
  // "Searching plugins across your selected collection(s)" text.
  searchedCollIds: null,
  // ESLifier exclusion filter (2026-08-24, merge-step1-eslifier-filter) -- eslifierExclude is the
  // checkbox's own state, ON by default per the task spec. eslifierOutputDirConfigured comes fresh off
  // every /api/merge/plugins response (Settings can change the folder without a restart); false until
  // the first search completes, same "assume configured until told otherwise" default as Missing
  // Masters' own mmEslifierOutputDirConfigured.
  eslifierExclude: true,
  eslifierOutputDirConfigured: true,
  cart: new Map(), // fullPath -> item -- accumulates across every search, never reset by a new one
  pageSize: 25,
  page: 1,
  reviewItems: [], // after analyze(): cart items + {recordCount, newRecordCount, containsOverrides, masters, status}
  outputDir: '',
  // Merge Update Report hand-off (2026-08-25, mergeStartWithSourceMerge) -- lowercased filenames of
  // the source merge's own plugins whose owning mod has since updated, so mergeBuildResultRow can
  // badge those specific Step 1 rows. Empty unless a "Create a new version" jump just happened --
  // mergeEnterStep1 resets this (and hides mergeSourceMergeBanner) at the START of every ORDINARY
  // Step 1 entry, so a later, unrelated Back-to-Step-0-and-search-again visit in the same session
  // never carries a stale badge over onto a coincidentally-matching filename in different results.
  sourceMergeUpdatedFilenamesLower: new Set(),
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
  const lastStep = MERGE_STEPS.length - 1;
  $m('mergeStepper').innerHTML = MERGE_STEPS.map((label, i) => {
    // Reaching the last step (Done) means the whole merge actually completed -- render it green
    // (same "done" treatment earlier steps get), not the blue "active" treatment every other
    // in-progress step uses (2026-08-24, merge-done-step-green).
    const isDone = i < mergeState.step || (i === mergeState.step && i === lastStep);
    const cls = isDone ? 'done' : i === mergeState.step ? 'active' : '';
    const num = isDone ? '✓' : String(i + 1);
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

// Refresh + auto-refresh (2026-08-24, merge-step0-refresh) -- the collections list used to load
// exactly once (loadMergeOnBoot's own eager call above, at script-load time regardless of which area
// is visible). Install or update a collection in Vortex while this tab was already open, and it
// never showed up without a full page reload. mergeCollRefreshBtn re-runs the SAME
// mergeLoadCollections() the page already calls on load -- no separate fetch/render path to keep in
// sync.
$m('mergeCollRefreshBtn').addEventListener('click', () => mergeLoadCollections());

// Full reset back to Step 0, PLUS a fresh collections refetch (2026-08-27, merge-entry-reset) --
// called from shell.js's navigateToArea, ONLY when actually arriving at 'merge' from a DIFFERENT
// area (that check lives in shell.js, using its own currentArea tracking, since this file has no
// visibility into area-level navigation on its own) -- so this fires once per genuine "opened Merge
// Plugins" and never again just from switching BROWSER tabs and back (no visibilitychange listener
// anywhere touches this) or from internal step navigation within Merge Plugins itself (Back/Merge
// another use mergeGoToStep directly, never navigateToArea, so they never re-trigger this).
//
// Replaces the old mergeAutoRefreshCollectionsOnEntry (2026-08-24, merge-step0-refresh), which only
// ever re-fetched the collections LIST -- it never touched mergeState.step or any of Step 1/2's own
// accumulated search/cart/review state, so the wizard itself just sat exactly where it was. Confirmed
// real, 2026-08-27: leave Merge Plugins for Home, visit another tool, come back -- it was still
// sitting on whatever step you left it on (e.g. Step 2's own Review table), instead of a fresh start
// like every other tool's own entry behavior (same convention as update-collection-v2-app.js's own
// ucv2ResetOnEntry). Reuses mergeAnotherBtn's own reset body verbatim (same real, already-tested
// clear-state-then-re-render-then-clear-DOM sequence, not a new mechanism), plus the original
// mergeLoadCollections() fetch this function is replacing -- one real fetch/render implementation,
// not a second copy. outputDir is deliberately left untouched here too, same reasoning as that
// handler's own comment: it's a sticky preference (pre-filled from Settings' own mergeOutputDir on
// boot), not wizard progress, so there's nothing stale about carrying it across a Home-and-back visit.
function mergeResetOnEntry() {
  mergeState.searchResults = [];
  $m('mergeSearchInput').value = '';
  mergeState.collSelected.clear();
  mergeRenderCollectionList();
  mergeState.cart.clear();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
  mergeGoToStep(0);
  mergeLoadCollections();
}
window.mergeResetOnEntry = mergeResetOnEntry;

// Merge Update Report's own "Create a new version →" hand-off (2026-08-25,
// design/mockup-merge-plugins-new-features.html section 7) -- lands on Step 1 with every one of the
// source merge's own original plugins already checked (real, editable checkboxes -- unchecking one
// or adding more is ordinary Step 1 behavior underneath, nothing new), and the ones whose owning mod
// has since updated visibly badged. Auto-selects whichever collection(s) those plugins actually came
// from at Step 0 (mergeState.collSelected) rather than making the user reconstruct that by hand --
// still just an ordinary Step 0 selection underneath, so Back still works normally from here.
async function mergeStartWithSourceMerge(sourceMergeId) {
  mergeHideError();
  try {
    const data = await mergeApi('GET', `/api/merge-update-report/merge?id=${encodeURIComponent(sourceMergeId)}`);
    if (!mergeState.collections.length) await mergeLoadCollections();
    const collectionNames = new Set((data.plugins || []).map((p) => p.collectionName).filter(Boolean));
    mergeState.collSelected = new Set(mergeState.collections.filter((c) => collectionNames.has(c.name)).map((c) => c.modId));
    mergeRenderCollectionList();

    mergeGoToStep(1);
    // Explicit, AWAITED search of our own -- mergeEnterStep1's own internal call (triggered by the
    // collSelected change above) is fire-and-forget, so it's not a reliable signal that
    // mergeState.searchResults is actually ready to pre-check against. Calling mergeRunSearch again
    // here is idempotent (a second, harmless re-fetch+re-render) -- simpler than threading a
    // completion callback through mergeEnterStep1 for what's a rare, user-initiated jump, not a hot
    // path.
    await mergeRunSearch();

    const wantedLower = new Set((data.plugins || []).map((p) => p.filename.toLowerCase()));
    mergeState.sourceMergeUpdatedFilenamesLower = new Set((data.plugins || []).filter((p) => p.updated).map((p) => p.filename.toLowerCase()));
    for (const item of mergeState.searchResults) {
      if (wantedLower.has(item.fileName.toLowerCase())) mergeSetCartMembership(item, true);
    }
    mergeRenderResultsPage();
    mergeUpdateCartBar();
    mergeRefreshCartWindow();

    const updatedCount = mergeState.sourceMergeUpdatedFilenamesLower.size;
    $m('mergeSourceMergeBannerTitle').textContent = `🔄 Rebuilding ${data.filename} — ${data.plugins.length} plugin${data.plugins.length === 1 ? '' : 's'} pre-selected from your last build`;
    $m('mergeSourceMergeBannerBody').textContent = updatedCount > 0
      ? `Take a quick look below before merging — ${updatedCount} flagged plugin${updatedCount === 1 ? '' : 's'} ${updatedCount === 1 ? 'has' : 'have'} been updated in Vortex since this merge was last built.`
      : 'Review the list below before merging.';
    $m('mergeSourceMergeBanner').classList.remove('hidden');
  } catch (e) {
    mergeHandleError(e);
  }
}
window.mergeStartWithSourceMerge = mergeStartWithSourceMerge;

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
  $m('mergeCollListWrap').classList.add('hidden');
  try {
    // {installed, workshop} (2026-08-27, superseding the previous flat-array shape) -- director's
    // own live correction: excluding Workshop entirely was the wrong fix for the real bug (a stale
    // Workshop draft's own mod count/plugin list leaking into the picker indistinguishably from a
    // real install) -- the right fix is showing both, clearly labeled, same shared split
    // Rebuild Missing Files/Workshop Report already use (lib/missing-files-scan.js's
    // listPickableCollections). mergeState.collections stays the flat union for everything that
    // doesn't care about the split (selection, counting, Merge Update Report's own name lookup).
    const { installed, workshop } = await mergeApi('GET', '/api/merge/collections');
    mergeState.collectionsBySection = { installed, workshop };
    mergeState.collections = [...installed, ...workshop];
    $m('mergeCollLoading').classList.add('hidden');
    if (!mergeState.collections.length) {
      $m('mergeCollEmpty').textContent = 'No installed collections found. Set up your staging folder under Settings, or install a collection in Vortex first.';
      $m('mergeCollEmpty').classList.remove('hidden');
      return;
    }
    $m('mergeCollListWrap').classList.remove('hidden');
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
  // Top and bottom Next always agree (2026-08-24, merge-step0-top-next) -- one disabled state, set
  // in the one place that already owns it, never two independent copies that could drift apart.
  $m('mergeStep0NextBtn').disabled = n === 0;
  $m('mergeStep0NextBtnTop').disabled = n === 0;
}

// One real .coll-card per collection (2026-08-27, director's own live ask: "I wanted to use the
// same UI as the other tools -- so they are all look the same and I don't have a long scroll with a
// long list of collections") -- the EXACT shared card shape clear-update-flags-app.js's own
// cufCollectionCard/rebuild-missing-app.js's own rmfCollectionCard already establish (checkbox +
// .meta block with .name/.sub, dense .picker-grid layout), not this tool's own former .merge-chk-row
// row (which is what made a real 33-collection staging folder a long, tall scroll -- confirmed live,
// the actual repro this ask came from). No flagged-count concept applies here the way it does for
// Clear Update Flags -- the sub-line is just the real mod count.
function mergeCollectionCard(c) {
  const checkbox = el('input', { type: 'checkbox' });
  checkbox.checked = mergeState.collSelected.has(c.modId);
  const card = el('label', { class: checkbox.checked ? 'coll-card sel' : 'coll-card' }, [
    checkbox,
    el('div', { class: 'meta' }, [
      el('div', { class: 'name' }, c.name),
      el('div', { class: 'sub' }, `${c.modCount.toLocaleString()} mod${c.modCount === 1 ? '' : 's'}`),
    ]),
  ]);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) mergeState.collSelected.add(c.modId);
    else mergeState.collSelected.delete(c.modId);
    card.classList.toggle('sel', checkbox.checked);
    mergeUpdateCollCount();
  });
  return card;
}

// Mirrors clear-update-flags-app.js's own cufRenderPickerGroup SHAPE exactly (section hidden
// entirely when its own items are empty, a live "N collection(s)" count next to the header).
function mergeRenderCollectionGroup(sectionId, countId, listId, items) {
  $m(sectionId).classList.toggle('hidden', items.length === 0);
  $m(countId).textContent = items.length ? `${items.length} collection${items.length === 1 ? '' : 's'}` : '';
  const list = $m(listId);
  list.innerHTML = '';
  for (const c of items) list.appendChild(mergeCollectionCard(c));
}

function mergeRenderCollectionList() {
  mergeRenderCollectionGroup('mergeCollInstalledSection', 'mergeCollInstalledCount', 'mergeCollInstalledList', mergeState.collectionsBySection.installed);
  mergeRenderCollectionGroup('mergeCollWorkshopSection', 'mergeCollWorkshopCount', 'mergeCollWorkshopList', mergeState.collectionsBySection.workshop);
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
$m('mergeStep0NextBtnTop').addEventListener('click', () => mergeGoToStep(1));

// ---------- Step 1: find & select plugins ----------

function mergeEnterStep1() {
  // Reset the Merge Update Report hand-off's own leftover state (2026-08-25) -- every ORDINARY entry
  // starts clean; mergeStartWithSourceMerge re-applies its own badge/banner state right after calling
  // mergeGoToStep(1), which runs this function synchronously first, so that override always lands.
  mergeState.sourceMergeUpdatedFilenamesLower = new Set();
  $m('mergeSourceMergeBanner').classList.add('hidden');
  const names = mergeState.collections.filter((c) => mergeState.collSelected.has(c.modId)).map((c) => c.name);
  $m('mergeStep1Sub').textContent = `Searching plugins across your selected collection${names.length === 1 ? '' : 's'}. Search and pick as many times as you like—every selection is added to the merge and saved in your queue.`;
  mergeRenderExtensionTags();
  mergeUpdateCartBar();
  // Real bug fix (2026-08-24, merge-step1-stale-search-fix): this used to only check
  // `!mergeState.searchResults.length`, so re-entering Step 1 after going BACK to Step 0 and
  // changing the selection (deselect collection A, select collection B, Next again) skipped
  // mergeRunSearch entirely whenever the OLD search's results were still non-empty -- silently
  // showing collection A's stale plugin list under B's own "Searching the plugins in your 1 chosen
  // collection" text. Confirmed live: selected Grass Mods (2 plugins) -> Step 1 -> Back -> switched
  // to a 33-mod collection -> Step 1 again still showed the same 2 Grass Mods plugins. Now also
  // re-searches whenever the current selection's fingerprint no longer matches what was actually
  // searched last (mergeCollIdsFingerprint, order-independent so reselecting the exact same set
  // doesn't trigger a needless re-search).
  if (!mergeState.searchResults.length || mergeState.searchedCollIds !== mergeCollIdsFingerprint(mergeState.collSelected)) {
    mergeRunSearch();
  } else {
    // Re-sync the current page's checkboxes and the selection pill from the cart every time this
    // step is (re-)entered without a fresh search (merge-step1-picker-fix, 2026-08-24) -- the cart
    // can change elsewhere (e.g. removing an item on Step 2, then clicking Back) without a new
    // search ever running, and the pill's whole job is to never show a stale number.
    mergeRefreshRowsFromCart();
    mergeUpdateSelectionCount();
    mergeCheckSelectAllBanner();
  }
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

// Sorted, order-independent fingerprint of a Set of collection modIds -- Set iteration order follows
// insertion order, which can differ between two selections with identical CONTENT (deselect A,
// reselect A back), so a plain join() would falsely detect drift there. Shared by mergeRunSearch
// (records what it actually searched) and mergeEnterStep1 (checks whether the current selection still
// matches that).
function mergeCollIdsFingerprint(collSelected) {
  return [...collSelected].sort().join(',');
}

// ESLifier exclusion filter (2026-08-24, merge-step1-eslifier-filter) -- pure client-side view over
// mergeState.searchResults. Every render/selection/count call site below reads THIS instead of
// mergeState.searchResults directly, so a hidden ESLifier-output plugin is excluded from being shown,
// paged, counted, or swept up by Select All/Invert/Clear/the header checkbox. mergeState.searchResults
// itself stays the raw fetched set, untouched -- mergeEnterStep1's own staleness check and
// mergeRunSearch's own fetch/assignment both still read/write that directly.
function mergeVisibleResults() {
  if (!mergeState.eslifierExclude) return mergeState.searchResults;
  return mergeState.searchResults.filter((it) => !it.eslifierOutput);
}

// Refreshes the "N plugins hidden" line and the not-configured-yet callout from the CURRENT
// mergeState.searchResults + eslifierExclude/eslifierOutputDirConfigured. Called after every fresh
// search and every checkbox/"Show them anyway" toggle -- never triggers a re-fetch itself.
function mergeUpdateEslifierHint() {
  $m('mergeEslifierEmptyHint').classList.toggle('hidden', mergeState.eslifierOutputDirConfigured);
  const hiddenCount = mergeState.eslifierExclude
    ? mergeState.searchResults.filter((it) => it.eslifierOutput).length
    : 0;
  const hint = $m('mergeEslifierHiddenHint');
  if (hiddenCount > 0) {
    $m('mergeEslifierHiddenLead').textContent = `${hiddenCount} plugin${hiddenCount === 1 ? '' : 's'} in your`;
    $m('mergeEslifierHiddenTail').textContent = `${hiddenCount === 1 ? 'is' : 'are'} hidden from this list — they're intentional replacements, not separate mods to merge.`;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}
$m('mergeEslifierExcludeInput').addEventListener('change', (e) => {
  mergeState.eslifierExclude = e.target.checked;
  mergeState.page = 1;
  mergeUpdateEslifierHint();
  mergeUpdateResultsSummary();
  mergeRenderResultsPage();
});
$m('mergeEslifierShowAnywayLink').addEventListener('click', (e) => {
  e.preventDefault();
  $m('mergeEslifierExcludeInput').checked = false;
  mergeState.eslifierExclude = false;
  mergeState.page = 1;
  mergeUpdateEslifierHint();
  mergeUpdateResultsSummary();
  mergeRenderResultsPage();
});

// "N plugins found"/"Results for ..." + the no-results message -- both scoped to the VISIBLE
// (post-ESLifier-filter) set, same scope mergeRenderResultsPage/Select All/the selection pill already
// use, so the header never claims a count the table itself doesn't back up. Split out of mergeRunSearch
// (2026-08-24, merge-step1-eslifier-filter) so toggling the filter can refresh this line too, without
// re-running the actual search.
function mergeUpdateResultsSummary() {
  const q = $m('mergeSearchInput').value.trim();
  const visible = mergeVisibleResults();
  $m('mergeResultsSummary').textContent = q ? `Results for "${q}" · ${visible.length} match${visible.length === 1 ? '' : 'es'}` : `${visible.length} plugin${visible.length === 1 ? '' : 's'} found`;
  $m('mergeNoResults').textContent = visible.length ? '' : (mergeState.searchResults.length
    ? 'Every matching plugin is ESLifier output, hidden by the filter above — click "Show them anyway" to see them.'
    : 'No matching plugins found in your chosen collections.');
}

async function mergeRunSearch() {
  mergeHideError();
  const q = $m('mergeSearchInput').value.trim();
  const collectionIds = [...mergeState.collSelected].join(',');
  try {
    const { results, eslifierOutputDirConfigured } = await mergeApi('GET', `/api/merge/plugins?collections=${encodeURIComponent(collectionIds)}&q=${encodeURIComponent(q)}&extensions=${encodeURIComponent(mergeState.extensions.join(','))}`);
    mergeState.searchResults = results;
    mergeState.eslifierOutputDirConfigured = !!eslifierOutputDirConfigured;
    // Recorded only on a SUCCESSFUL search (2026-08-24, merge-step1-stale-search-fix) -- if this
    // request fails, the fingerprint must NOT update, so mergeEnterStep1 keeps treating the results
    // as stale/missing and retries on the next visit rather than wrongly trusting a search that never
    // actually completed for the current selection.
    mergeState.searchedCollIds = mergeCollIdsFingerprint(mergeState.collSelected);
    mergeState.page = 1;
    mergeUpdateEslifierHint();
    mergeRenderResultsPage();
    mergeUpdateResultsSummary();
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
  const { pageItems, totalPages, total } = mergePaginate(mergeSortedRows(mergeVisibleResults(), mergeResultsSort));
  $m('mergeSelectionActions').classList.toggle('hidden', !total);
  // Called unconditionally, even when this search has zero results (see below) -- the pill next to
  // the headline (merge-step1-picker-fix, 2026-08-24) always reads the true, whole-picker cart size,
  // not something scoped to what this particular search happens to show.
  mergeUpdateSelectionCount();
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
  mergeCheckSelectAllBanner();
}

function mergeBuildResultRow(item) {
  const key = MERGE_ITEM_KEY(item);
  const checkbox = el('input', { type: 'checkbox' });
  checkbox.checked = mergeState.cart.has(key);
  const typeClass = item.extension === '.esl' ? 'status-pill--info' : 'status-pill--neutral';
  // Merge Update Report hand-off badge (2026-08-25) -- see mergeStartWithSourceMerge's own comment.
  // Empty set on any normal Step 1 visit, so this is a no-op outside that jump.
  const updatedBadge = mergeState.sourceMergeUpdatedFilenamesLower.has(item.fileName.toLowerCase())
    ? el('span', { class: 'badge badge--warning badge--sm' }, 'Updated')
    : null;
  const tr = el('tr', {}, [
    el('td', { class: 'col-check' }, [checkbox]),
    el('td', {}, [item.fileName, mergeMasterBadge(item.fileName), updatedBadge]),
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
    // Full re-sync from the cart, not just this one row (merge-step1-picker-fix, 2026-08-24) -- two
    // rows on the SAME page can share the identical fullPath (a plugin belonging to more than one
    // chosen collection, see mergeUpdateSelectionCount's own comment). Before this fix, only THIS
    // row's own checkbox/class got updated, so a sibling row sharing its key stayed visually stale
    // until some other re-render happened -- meaning unchecking what looked like a still-checked
    // "different" row could silently clear the shared cart entry while its own checkbox kept showing
    // checked. mergeRefreshRowsFromCart re-derives every row's checked state fresh from the cart, so
    // any row sharing this key updates immediately, and also covers mergeUpdateHeaderCheckboxState.
    mergeRefreshRowsFromCart();
    mergeUpdateSelectionCount();
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
  const { pageItems } = mergePaginate(mergeSortedRows(mergeVisibleResults(), mergeResultsSort));
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

// Root cause (merge-step1-picker-fix, 2026-08-24): the OLD version counted matching ROWS in the
// current search (`searchResults.filter(cart.has)`), not distinct entries in the cart itself. A
// plugin shared by two chosen collections shows as two separate rows with the IDENTICAL fullPath
// (lib/merge-plugin-scan.js's scanCollectionPlugins pushes one row per collection that references
// it) -- confirmed live and common (775 duplicate-fullPath groups found across just 8 real
// collections, some even duplicated within a single collection). mergeState.cart is a Map keyed by
// fullPath (MERGE_ITEM_KEY), so checking two such rows only ever adds ONE cart entry -- but the old
// formula counted BOTH rows as "selected", silently inflating the on-screen number above what the
// cart (and therefore the merge, and therefore Step 2's own count -- see mergeEnterStep2's `items =
// Array.from(mergeState.cart.values())`) actually holds. That gap between "rows checked" and "cart
// size" is exactly what let 30-checked-but-23-merged go unnoticed.
//
// Now reads mergeState.cart.size directly -- the same true, running, whole-picker total every other
// step already uses -- so this can never again show a number bigger than what will actually merge.
// The denominator is also deduped by fullPath (not a raw row count) for the same reason: with
// duplicate rows in play, a raw row count could never be reached by checking every box, which would
// be its own small version of the same "count that lies" problem.
//
// mergeState.cart can legitimately hold MORE unique items than are in the CURRENT search's results
// (items picked during an earlier, different search) -- true by design ("each pick adds to the merge
// and stays put"), so `n` can exceed `uniqueTotal`; the pill shows that honestly (e.g. "38 of 20
// selected") rather than clamping it, since the goal is a number that's never silently wrong, not one
// that's always tidy.
function mergeUpdateSelectionCount() {
  const uniqueTotal = new Set(mergeVisibleResults().map(MERGE_ITEM_KEY)).size;
  const n = mergeState.cart.size;
  $m('mergeSelectionPillText').textContent = uniqueTotal ? `${n} of ${uniqueTotal} selected` : `${n} selected`;
  const pill = $m('mergeSelectionPill');
  pill.classList.toggle('badge--show-all', n === 0);
  pill.classList.toggle('badge--info', n > 0);
}

$m('mergeSelectAllBtn').addEventListener('click', () => {
  for (const it of mergeVisibleResults()) mergeSetCartMembership(it, true);
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeCheckSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});
$m('mergeInvertBtn').addEventListener('click', () => {
  for (const it of mergeVisibleResults()) mergeSetCartMembership(it, !mergeState.cart.has(MERGE_ITEM_KEY(it)));
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeCheckSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});
$m('mergeClearSearchBtn').addEventListener('click', () => {
  for (const it of mergeVisibleResults()) mergeSetCartMembership(it, false);
  mergeRefreshRowsFromCart();
  mergeUpdateSelectionCount();
  mergeHideSelectAllBanner();
  mergeUpdateCartBar();
  mergeRefreshCartWindow();
});
$m('mergeSelectAllBannerBtn').addEventListener('click', () => {
  for (const it of mergeVisibleResults()) mergeSetCartMembership(it, true);
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
  const visible = mergeVisibleResults();
  const total = visible.length;
  const pageItems = mergeCurrentPageItems();
  const pageSelected = pageItems.filter((it) => mergeState.cart.has(MERGE_ITEM_KEY(it))).length;
  const allPageSelected = pageItems.length > 0 && pageSelected === pageItems.length;
  const allSelected = total > 0 && visible.every((it) => mergeState.cart.has(MERGE_ITEM_KEY(it)));
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
      // other now (see lib/merge-v2-worker.js's copyRecords/isOverrideInMerge for the real, live
      // handling; the original "contains overrides -> can't be merged" scope decision this replaced
      // lived in the old engine's own runMerge, removed 2026-08-25 -- see TECHNICAL.md's "Merge
      // Plugins: v1 engine retired" section). Priority unchanged from before: an item with both
      // overrides AND its own declared masters still shows as 'override' first (the more
      // specific/interesting fact).
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

  $m('mergeReviewSub').textContent = `${items.length} plugin${items.length === 1 ? '' : 's'} selected for the merge. Filter the list, remove unneeded plugins, or search again to add more. Status flags are purely informational and won't block the merge.`;

  const masterCallout = $m('mergeMasterCallout');
  if (nMaster > 0) {
    masterCallout.classList.remove('hidden');
    masterCallout.innerHTML = `<div class="callout__title">⚠️ ${nMaster} plugin${nMaster === 1 ? '' : 's'} depend${nMaster === 1 ? 's' : ''} on a master</div><p>Fine to merge — just make sure those masters are installed in Vortex. If one's missing after you install the merge, <strong>Missing Masters</strong> will catch it.</p>`;
  } else {
    masterCallout.classList.add('hidden');
  }

  // Informational only (2026-08-17) -- these plugins merge fine now, see
  // lib/merge-v2-worker.js's copyRecords for how their overrides carry over correctly.
  const overrideCallout = $m('mergeOverrideCallout');
  if (nOverride > 0) {
    overrideCallout.classList.remove('hidden');
    const overrideAreIs = nOverride === 1 ? 'is' : 'are';
    const overridePatchNoun = nOverride === 1 ? 'a patch' : 'patches';
    overrideCallout.innerHTML = `<div class="callout__title">⚠️ ${nOverride} of these ${overrideAreIs} ${overridePatchNoun}</div><p>Patches override records from other mods rather than just introducing new content. This is completely normal—the merge automatically preserves the original mods as required masters so every tweak continues to apply as intended.</p>`;
  } else {
    overrideCallout.classList.add('hidden');
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
  $m('mergeResultPreview').textContent = mergeOutputFileName();
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
// which as of 2026-08-17 is just reviewItems in full: 'override' no longer excludes anything --
// see mergeRenderReviewStep's own comment above for where that live handling actually runs now).
// Kept as an explicit parameter rather than
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

// ---- Pre-flight (2026-08-23) -------------------------------------------------------------------
// "Check up front and show what's wrong" -- the director's own explicit ask after a real merge died
// at plugin 11 of 53 with nothing but a generic "something went wrong". Everything about to be
// loaded is checked first, and anything that can't be is LISTED, before a single plugin is read.
//
// Two tiers, because they genuinely differ (see lib/merge-preflight.js's checkLoadList): a blocking
// problem means a file can't be read at all and there is nothing to do but fix it, while a
// non-blocking one -- a declared master that isn't installed -- has always been survivable, so the
// merge stays available and the user decides. The modal is the same either way; only the icon, the
// lead sentence and whether Build Anyway exists change.
let mergePendingPreflightBuild = null;

function mergeOpenPreflightModal(problems, onContinue) {
  const blocking = problems.filter((p) => p.blocking);
  const warnings = problems.filter((p) => !p.blocking);
  const isBlocked = blocking.length > 0;
  mergePendingPreflightBuild = isBlocked ? null : onContinue;

  const listFor = (list) => list.map((p) =>
    `<li><strong>${escMergeHtml(p.fileName)}</strong> &mdash; ${escMergeHtml(p.detail)}</li>`).join('');

  $m('mergePreflightModalTitle').textContent = isBlocked
    ? '\u{1F6D1} These plugins can\u2019t be loaded'
    : '\u26A0\uFE0F Some files are missing';

  let html = '';
  if (isBlocked) {
    html += `<p>The merge was stopped before it started. ${blocking.length === 1 ? 'This plugin has' : 'These plugins have'} a problem that has to be sorted out first:</p><ul>${listFor(blocking)}</ul>`;
    if (warnings.length) html += `<p>Also worth knowing about:</p><ul>${listFor(warnings)}</ul>`;
    html += '<p>Take these out of your selection, or fix them in Vortex, then try again.</p>';
  } else {
    html += `<p>${warnings.length === 1 ? 'One file the plugins you picked rely on isn\u2019t' : 'Some files the plugins you picked rely on aren\u2019t'} installed:</p><ul>${listFor(warnings)}</ul>`;
    html += '<p>You can go ahead and build, but anything that depends on the missing file may not carry over. Cancel if you\u2019d rather install it first.</p>';
  }
  $m('mergePreflightModalText').innerHTML = html;
  $m('mergePreflightContinueBtn').classList.toggle('hidden', isBlocked);
  $m('mergePreflightCancelBtn').textContent = isBlocked ? 'Close' : 'Cancel';
  $m('mergePreflightModal').classList.remove('hidden');
}
$m('mergePreflightCancelBtn').addEventListener('click', () => {
  mergePendingPreflightBuild = null;
  $m('mergePreflightModal').classList.add('hidden');
});
$m('mergePreflightContinueBtn').addEventListener('click', () => {
  $m('mergePreflightModal').classList.add('hidden');
  const go = mergePendingPreflightBuild;
  mergePendingPreflightBuild = null;
  if (go) go();
});

// Overwrite check (2026-08-24, merge-overwrite-warning) -- called right before mergeProceedWithMerge
// from EVERY path that leads there (the happy path below, and the preflight modal's own confirm
// callback), so a real existing output file always gets a real confirm regardless of which path got
// the user here. Serious register (plain-language-writer skill) -- this is a genuine, permanent,
// easy-to-not-notice-until-later overwrite, not a casual heads-up. Non-fatal on its own failure, same
// philosophy as the master-dependency/preflight checks above: web/merge-routes.js's own /merge route
// independently re-checks the same path right before it writes and refuses outright unless this
// returned a real confirmed `overwrite: true` -- so a check that couldn't run here just means the
// user hits that real backstop instead of this nicer client-side confirm, never a silent overwrite.
async function mergeConfirmOverwrite(outputDir) {
  try {
    const check = await mergeApi('GET', `/api/merge/output-exists?outputDir=${encodeURIComponent(outputDir)}&outputName=${encodeURIComponent(mergeOutputFileName())}`);
    if (!check.exists) return { proceed: true, overwrite: false };
    const existingName = check.path.slice(Math.max(check.path.lastIndexOf('\\'), check.path.lastIndexOf('/')) + 1);
    const ok = await window.showConfirmModal(`${existingName} already exists in this folder. Merging again will overwrite it — continue?`);
    return { proceed: ok, overwrite: ok };
  } catch {
    return { proceed: true, overwrite: false };
  }
}

// mergeGetSelectedMethod (2026-08-25, per-build picker) -- reads the mergeMethod radio group fresh
// every time, straight off the DOM, rather than tracking it in mergeState -- deliberately NOT a
// persisted/remembered value (director's own explicit call: this is a per-build choice, not a
// Settings default that silently applies to every future merge). Falls back to 'Clean' if nothing's
// checked, which should never happen given the radio's own `checked` default in index.html.
function mergeGetSelectedMethod() {
  const checked = document.querySelector('input[name="mergeMethod"]:checked');
  return checked ? checked.value : 'Clean';
}

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

  // Runs AFTER the master-dependency check above so the two modals can never both be open, and so
  // the "these plugins will stop working" question -- which can still change the selection, via
  // Include them in the merge -- is settled before we validate the final set. Same non-fatal
  // philosophy: a pre-flight that can't run itself never blocks a merge, and web/merge-routes.js's
  // own server-side copy of this check is the real backstop either way.
  try {
    const { problems } = await mergeApi('POST', '/api/merge/preflight', {
      items: included.map((it) => ({ fullPath: it.fullPath, fileName: it.fileName, modName: it.modName })),
    });
    if (problems && problems.length) {
      mergeOpenPreflightModal(problems, async () => {
        const { proceed, overwrite } = await mergeConfirmOverwrite(outputDir);
        if (proceed) mergeProceedWithMerge(included, outputDir, overwrite);
      });
      return;
    }
  } catch {
    // see above
  }

  const { proceed, overwrite } = await mergeConfirmOverwrite(outputDir);
  if (!proceed) return;
  mergeProceedWithMerge(included, outputDir, overwrite);
}
$m('mergeStartBtn').addEventListener('click', mergeStartMerge);

async function mergeProceedWithMerge(included, outputDir, overwrite) {
  mergeGoToStep(3);
  $m('mergeProgressSub').innerHTML = `Building <strong>${mergeOutputFileName()}</strong> from ${included.length} plugin${included.length === 1 ? '' : 's'}.`;
  $m('mergeProgressBar').style.width = '0%';
  $m('mergeProgressText').textContent = 'Starting…';

  try {
    await mergeApi('POST', '/api/merge/merge', {
      // collectionName added (2026-08-24, merge-restore-report-data) -- the /merge route has no other
      // way to know which chosen collection a plugin came from (it can't be re-derived server-side:
      // the same fullPath can belong to more than one chosen collection, and the route has no way to
      // know which one the user actually picked from). Feeds web/merge-routes.js's merge.json
      // enrichment for the future Restore/Revert report -- see design/mockup-merge-plugins-new-
      // features.html section 6.
      items: included.map((it) => ({ fullPath: it.fullPath, fileName: it.fileName, modName: it.modName, collectionName: it.collectionName })),
      outputName: mergeOutputFileName(),
      outputDir,
      // method (2026-08-25, per-build picker) -- a real per-request field read fresh off the radio
      // group on every build, never cached in mergeState or persisted -- see mergeGetSelectedMethod's
      // own header for why.
      method: mergeGetSelectedMethod(),
      // overwrite (2026-08-24, merge-overwrite-warning) -- explicit confirmed-intent signal, never
      // just "the client didn't error out." See /merge's own comment for why this is required, not
      // advisory: it refuses outright when a real existing file is found and this isn't exactly true.
      overwrite: !!overwrite,
    });
  } catch (e) {
    mergeGoToStep(2);
    // The server runs the same pre-flight; if IT blocked, show the real list rather than the bare
    // message (this path only happens when the client-side check above couldn't run).
    if (e.body?.error === 'preflight-blocked' && Array.isArray(e.body.problems)) {
      mergeOpenPreflightModal(e.body.problems, null);
      return;
    }
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
  $m('mergeDoneSlotBudget').classList.add('hidden'); // reset -- avoids a stale flash from a previous merge while the fresh fetch below is in flight
  const eslCallout = $m('mergeDoneEslCallout');
  eslCallout.classList.remove('hidden');
  $m('mergeDoneEslTitle').textContent = `🧬 ${outFile} created${result.eslFlagged ? ' — ESL-flagged' : ''}`;
  if (result.eslFlagged) {
    $m('mergeDoneEslBody').innerHTML = `Because it's light-flagged, it uses <strong>0</strong> of your 254 full load-order slots — instead it shares the separate light-plugin pool (capped at 4,096 total). You just freed up the full slots its originals were using.`;
    mergeHideLightSection();
    mergeRenderSlotBudget(included.length, true);
  } else {
    $m('mergeDoneEslBody').textContent = 'This is a full .esp taking up one of your 254 regular plugin slots.';
    mergeCheckLightEligibility(result.outputPath, outFile, included.length);
  }
  mergeRenderNextSteps(outFile, included.length, result.eslFlagged);

  // textContent, not innerHTML -- logContent is plain text from lib/merge-v2-worker.js's own logger
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
  mergeRenderFailedRecordsResult(result);
  mergeRenderStringFilesResult(result);
  mergeRenderStagingCopyResult(result);
}

// Failed-to-copy records (2026-08-25, merge-v2-failedtocopy-case) -- result.failedToCopy already
// travels end to end (lib/merge-v2-worker.js's copyRecords -> web/merge-routes.js's own /merge
// response -> here) with zero backend changes needed; this is purely the missing render step. Each
// entry is { plugin, name, error } (see copyRecords' own header). Hidden entirely when the array is
// empty or absent -- the overwhelming majority of real merges.
function mergeRenderFailedRecordsResult(result) {
  const callout = $m('mergeDoneFailedRecordsCallout');
  const failed = result.failedToCopy || [];
  if (!failed.length) {
    callout.classList.add('hidden');
    return;
  }
  $m('mergeDoneFailedRecordsTitle').textContent = `⚠️ ${failed.length} record${failed.length === 1 ? '' : 's'} couldn't be copied`;
  const names = failed.map((f) => `${f.name} (from ${f.plugin})`).join(', ');
  $m('mergeDoneFailedRecordsText').textContent = `Everything else in this merge copied over fine, but ${names} couldn't be added and ${failed.length === 1 ? 'was' : 'were'} left out. Open the merge log below for the full detail.`;
  callout.classList.remove('hidden');
}

// Unhandled string files (2026-08-25, merge-results-screen-asset-gap) -- result.unhandledStringFiles
// is a plain count (see lib/merge-v2-worker.js's own runMergeV2 comment), not a details array like
// failedToCopy above -- the log line string-file-handler.js now writes already names every affected
// file, so this callout points there rather than duplicating the list. DRAFT COPY -- not yet run
// through a Gemini pass, see this task's own handoff.
function mergeRenderStringFilesResult(result) {
  const callout = $m('mergeDoneStringFilesCallout');
  const count = result.unhandledStringFiles || 0;
  if (!count) {
    callout.classList.add('hidden');
    return;
  }
  $m('mergeDoneStringFilesTitle').textContent = `⚠️ ${count} localized string file${count === 1 ? '' : 's'} not rebuilt`;
  $m('mergeDoneStringFilesText').textContent = `This merge included ${count} localized string file${count === 1 ? '' : 's'}. Merge Plugins does not rebuild string files as part of the merge process. If any of the merged plugins rely on localized in-game text, check ${count === 1 ? 'it' : 'them'} manually. See the merge log below for the full list.`;
  callout.classList.remove('hidden');
}

// Staging folder auto-copy result (2026-08-25) -- web/merge-routes.js only ever sets
// stagingCopyPath/stagingCopyError when settingsMergeStagingCopyDirInput is actually configured (see
// its own comment), so this callout stays hidden entirely for anyone who hasn't set that up. A real
// copy failure gets its own visible warning, matching this app's own "never hide a real problem"
// convention -- the merge itself already succeeded either way, so this is ⚠️ (tread lightly, nothing
// is actually blocked), never 🛑.
function mergeRenderStagingCopyResult(result) {
  const callout = $m('mergeDoneStagingCopyCallout');
  if (result.stagingCopyPath) {
    callout.className = 'callout callout--success';
    $m('mergeDoneStagingCopyTitle').textContent = '🎉 Copied to your staging folder';
    $m('mergeDoneStagingCopyText').textContent = `${mergeOutputFileName()} is now sitting in ${result.stagingCopyPath} too, ready for Vortex to pick up as its own mod.`;
    callout.classList.remove('hidden');
  } else if (result.stagingCopyError) {
    callout.className = 'callout callout--warning';
    $m('mergeDoneStagingCopyTitle').textContent = "⚠️ Couldn't copy to your staging folder";
    $m('mergeDoneStagingCopyText').textContent = `Your merge finished fine, but we couldn't copy ${mergeOutputFileName()} into your configured staging folder (${result.stagingCopyError}). Move it there yourself before Vortex can pick it up.`;
    callout.classList.remove('hidden');
  } else {
    callout.classList.add('hidden');
  }
}

// Flag as Light (2026-08-24, merge-flag-as-light) -- mirrors Vortex's own real "Mark as Light"
// mechanism: a plain header flag-flip, gated on a REAL FormID-range validity scan of the actual
// finished file (never the pre-merge Review-step estimate, and never a blind toggle). See
// lib/esp-light-flag.js's own header comment for the full design writeup and the real Vortex source
// this was confirmed against. Only offered when the merge didn't already auto-flag itself
// (mergeRenderDoneStep's own eslFlagged branch above) -- if it's already light, there's nothing for
// this section to offer, so it stays fully hidden.
function mergeHideLightSection() {
  $m('mergeDoneLightCheck').classList.add('hidden');
  $m('mergeDoneLightEligibleActions').classList.add('hidden');
  $m('mergeDoneLightIneligibleText').classList.add('hidden');
}

// { outputPath, fileName } for the confirm/click handler below -- null until a real eligibility
// check has actually confirmed this specific merge is safe to flag.
let mergePendingLightFlag = null;
async function mergeCheckLightEligibility(outputPath, fileName, sourceCount) {
  mergeHideLightSection();
  mergePendingLightFlag = null;
  $m('mergeFlagAsLightBtn').disabled = false;
  $m('mergeFlagAsLightBtn').classList.remove('hidden');
  $m('mergeFlagAsLightResult').classList.add('hidden');
  $m('mergeFlagAsLightResult').innerHTML = '';
  $m('mergeDoneLightCheck').classList.remove('hidden');
  try {
    const check = await mergeApi('GET', `/api/merge/light-eligibility?outputPath=${encodeURIComponent(outputPath)}`);
    $m('mergeDoneLightCheck').classList.add('hidden');
    if (check.eligible) {
      mergePendingLightFlag = { outputPath, fileName, sourceCount };
      $m('mergeDoneEslBody').textContent = 'This is a full .esp taking up one of your 254 regular plugin slots. It can be safely flagged as light (ESL), freeing up a standard slot while counting toward your 4,096 light plugin limit.';
      $m('mergeDoneLightEligibleActions').classList.remove('hidden');
      mergeRenderSlotBudget(sourceCount, 'pending');
    } else {
      $m('mergeDoneLightIneligibleText').classList.remove('hidden');
      mergeRenderSlotBudget(sourceCount, false);
    }
  } catch {
    // Non-fatal (2026-08-24) -- the merge itself already succeeded; a failed eligibility check just
    // means this one optional action doesn't offer itself on this visit, not a reason to disrupt the
    // rest of the Done screen with an error box.
    $m('mergeDoneLightCheck').classList.add('hidden');
    mergeRenderSlotBudget(sourceCount, false);
  }
}

// Real, current light-plugin slot budget (2026-08-24, merge-light-slot-budget) -- see
// lib/load-order-slot-count.js's own header for why this is a genuinely different number from the
// per-plugin eligibility check above (system-wide slot count vs. this one file's own FormID range).
// `savings` controls the second sentence: `true` = this merge is ALREADY flagged, so the slots are
// freed for real (past tense); `'pending'` = eligible but not yet flagged, so flagging it WOULD free
// them (still needs the Flag as Light click above); `false` = no savings claim at all (ineligible, or
// the eligibility check itself failed) -- never promise a saving this merge hasn't actually earned.
async function mergeRenderSlotBudget(sourceCount, savings) {
  const el = $m('mergeDoneSlotBudget');
  try {
    const budget = await mergeApi('GET', '/api/merge/slot-budget');
    if (!budget.configured) { el.classList.add('hidden'); return; }
    const { light, lightLimit } = budget;
    const overBudget = light > lightLimit;
    const title = overBudget ? "⚠️ You're over your light-plugin budget" : '📊 Your light-plugin budget';
    let body = overBudget
      ? `You're using <strong>${light.toLocaleString()}</strong> of <strong>${lightLimit.toLocaleString()}</strong> light-plugin slots — <strong>${(light - lightLimit).toLocaleString()}</strong> over the limit.`
      : `You're currently using <strong>${light.toLocaleString()}</strong> of <strong>${lightLimit.toLocaleString()}</strong> light-plugin slots.`;
    if (savings && sourceCount > 1) {
      const freed = sourceCount - 1;
      body += savings === true
        ? ` Merging these ${sourceCount} plugins into one and flagging it as Light just freed up <strong>${freed}</strong> of them.`
        : ` Flagging this one would free up <strong>${freed}</strong> of them.`;
    }
    el.innerHTML = `<div class="callout__title">${title}</div><p>${body}</p>`;
    el.classList.remove('hidden');
  } catch {
    // Non-fatal, same convention as the eligibility check above -- an optional informational box,
    // never worth disrupting the rest of an already-successful Done screen over.
    el.classList.add('hidden');
  }
}

// Next Steps callout (2026-08-24, merge-done-screen-tighten) -- director's own exact copy shape, a
// real <ol> not manual "1."/"2." text. `alreadyFlagged` picks the closing line: the light-headroom
// celebration line is only accurate once this merge really IS light-flagged (auto-flagged at render
// time, or a manual Flag as Light click that just succeeded) -- for a merge that's staying a full
// .esp (ineligible, or eligible-but-not-yet-clicked), that line would be misleading, so it stays
// neutral there instead. Called again from the Flag as Light success handler below so the closing
// line updates live the moment a manual flag succeeds, not just at initial render.
function mergeRenderNextSteps(outFile, sourceCount, alreadyFlagged) {
  $m('mergeDoneNextStepsList').innerHTML = [
    `Install and enable <code>${escMergeHtml(outFile)}</code> as a mod in Vortex.`,
    `Go to the <strong>Plugins tab</strong> and verify the original ${sourceCount} plugin${sourceCount === 1 ? '' : 's'} ${sourceCount === 1 ? 'is' : 'are'} either disabled or deleted.`,
    `Click <strong>Deploy Mods</strong> in Vortex.`,
  ].map((step) => `<li>${step}</li>`).join('');
  $m('mergeDoneNextStepsClosing').textContent = alreadyFlagged
    ? "You're all set—enjoy the extra headroom on your light plugin limit!"
    : "You're all set!";
}

$m('mergeFlagAsLightBtn').addEventListener('click', async () => {
  if (!mergePendingLightFlag) return;
  const { outputPath, fileName, sourceCount } = mergePendingLightFlag;
  const ok = await window.showConfirmModal(`Flag "${fileName}" as a light plugin?\n\nThis modifies the file on disk. The plugin will free up one regular slot and use a light mod slot instead (up to 4,096 total).`);
  if (!ok) return;
  const btn = $m('mergeFlagAsLightBtn');
  btn.disabled = true;
  const resultEl = $m('mergeFlagAsLightResult');
  resultEl.classList.remove('hidden');
  resultEl.textContent = 'Flagging…';
  try {
    await mergeApi('POST', '/api/merge/flag-as-light', { outputPath });
    // Update the SAME shared title/body the combined banner already uses, rather than writing a
    // second title into resultEl below it -- otherwise the old "created" text never goes away and
    // the box shows two titles stacked (real bug, caught live 2026-08-24).
    $m('mergeDoneEslTitle').textContent = `🪶 ${fileName} — now flagged as Light`;
    $m('mergeDoneEslBody').textContent = "It loads as a light plugin (an ESPFE) now — no longer uses one of your 254 full load-order slots, and instead shares the separate light-plugin pool (capped at 4,096 total).";
    resultEl.classList.add('hidden');
    resultEl.textContent = '';
    $m('mergeDoneLightEligibleActions').classList.add('hidden'); // done -- nothing left to offer again on this Done screen
    mergeRenderSlotBudget(sourceCount, true); // now actually flagged -- switch the savings line from "would free up" to "just freed up"
    mergeRenderNextSteps(fileName, sourceCount, true); // now actually flagged -- switch the closing line to the light-headroom celebration
  } catch (e) {
    resultEl.classList.add('hidden');
    resultEl.textContent = '';
    mergeHandleError(e);
    btn.disabled = false;
  }
});

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
  // Shares its real reset body with mergeResetOnEntry (2026-08-27, merge-entry-reset) -- same
  // "clear state, re-render, clear DOM" sequence either way (real bug fix from 2026-08-24,
  // merge-another-full-reset: collSelected/cart are Maps/Sets, so clearing the state alone doesn't
  // un-check the actual DOM checkboxes). outputDir is deliberately left untouched by that shared
  // function -- re-picking an output folder for every merge in a batch session would be real
  // friction, not a fix.
  mergeResetOnEntry();
  $m('mergeOutputNameInput').value = '';
  mergeUpdateOutputPreview();
});

// ---------- Init ----------

mergeRenderStepper();
loadMergeOnBoot();
