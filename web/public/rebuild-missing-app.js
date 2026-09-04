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

// Real 3rd stage (2026-08-25) -- .stepnote's 2-step badge no longer fit once "Done" became a real,
// distinct state (see DESIGN.md's own "reach for the full stepper once a tool has 3+ stages" rule).
// Read-only status indicator, not independently navigable -- Step 2/3 are both the same physical
// screen (rmfReportView), just different states of it, so there's no separate screen to jump to for
// either. Step 1 alone doubles as a real shortcut, wired below, matching rmfBackToPickerBtn's own
// "go back to the picker" action.
const RMF_STEPS = ['Collections', 'Scan Results', 'Done'];
// scanning (2026-08-25): Step 2's own pill reads "Scanning…" for the duration of a real scan,
// reverting to "Scan Results" the moment it lands -- same "the pill should say what's actually
// happening right now" reasoning as the Cancel/Back label swap on the button above it.
function rmfRenderStepper(step, scanning) {
  $g('rmfStepper').innerHTML = RMF_STEPS.map((label, i) => {
    const cls = i === step ? 'active' : i < step ? 'done' : '';
    const num = i < step ? '✓' : String(i + 1);
    const text = i === 1 && scanning ? 'Scanning…' : label;
    return `<div class="merge-step ${cls}" data-step="${i}"><b>${num}</b>${text}</div>`;
  }).join('');
}
rmfRenderStepper(0);
$g('rmfStepper').addEventListener('click', (e) => {
  const pill = e.target.closest('.merge-step');
  if (!pill || pill.dataset.step !== '0') return; // only Step 1 is a real jump target
  $g('rmfBackToPickerBtn').click();
});

function rmfExceptionsName() {
  return window.themedToolName ? window.themedToolName('report-exceptions', 'Mod Exceptions') : 'Mod Exceptions';
}

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

// retryFn (queue: rebuild-missing-vortex-retry-noop): the function to re-run when the user clicks
// the "Vortex is running" modal's own Try Again button (shell.js's showVortexRunningModal calls
// whatever it's given). Every call site below now passes the real action that hit the gate --
// confirmed real 2026-08-15: this was hardcoded to `() => {}` for ALL 11 call sites in this file,
// so Try Again silently did nothing everywhere, not just the scan-start case the director hit.
// Same class of bug already fixed once in merge-app.js (2026-07-28, see its own mergeHandleError
// comment) -- falls back to a no-op only if a caller genuinely has nothing to retry (none do here;
// every site below has a real action available).
function rmfHandleError(e, box, retryFn) {
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    // Every RMF vortex-running gate is the Helper-unreachable-while-running case, never a genuine
    // "must be closed" one -- see rebuild-missing-routes.js's own gate comments. Same busy-detection
    // pattern update-collection-v2-app.js's ucv2HandleError already established (2026-08-30).
    const isBusy = /currently busy/i.test(e.body?.message || '');
    window.showVortexRunningModal(retryFn || (() => {}), isBusy ? {
      title: '⚠️ Vortex is currently busy',
      body: e.body.message,
    } : undefined);
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
    rmfHandleError(e, $g('rmfNotConfigured'), rmfLoadCollections);
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

// Named (not an inline listener) so a Vortex-running retry can re-call the exact same logic --
// same reasoning as rmfDoExtract further below.
async function rmfLoadVortexData() {
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
    rmfHandleError(e, $g('rmfVortexDataError'), rmfLoadVortexData);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
$g('rmfLoadVortexDataBtn').addEventListener('click', rmfLoadVortexData);

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
    // data-mod-id: lets the cart bar's own "which ones?" tag list find and uncheck the right
    // checkbox when a tag's × is clicked, without threading a separate id->element map around.
    const checkbox = el('input', { type: 'checkbox', 'data-mod-id': item.modId });
    checkbox.checked = rmfState.picked.has(item.modId);
    // "Last checked" / "Last extracted" (queue: rebuild-missing-last-checked; "Last extracted" is
    // the director's own rename of the original "Last dealt with" label, matching Rebuild
    // Collection's own picker label for the same underlying concept -- see app.js) -- same single
    // inline-dash-suffix convention that other picker already uses, not Workshop Report's own
    // two-line absolute+relative format -- that fits a wide table column, this is a narrow card with
    // room for exactly one compact sub-line (it wraps naturally via .sub's own CSS if it gets long,
    // no explicit second <div>). Either or both are absent (not a blank/zero date) for a collection
    // this router has never scanned/fixed, per the original task's own instruction.
    //
    // Two distinct facts -- checked = most recent scan completion regardless of outcome, extracted =
    // most recent REAL fix (extract OR download-archive; the label says "extracted" but
    // lastFixedState.markFixed also fires from a bare archive download with nothing actually
    // extracted -- a known small inaccuracy, not something this rename fixes) -- but a fix always
    // happens right after the scan that found it, in the same visit (this router never re-scans
    // after a fix), so when the two timestamps land close together they're describing the same visit
    // and showing both would just be near-duplicate noise. Collapsed to "Last extracted" alone in
    // that case (it's the more specific fact, and implies a check happened too); shown as two
    // separate facts once they've drifted apart, which happens naturally as later clean scans keep
    // pushing "Last checked" forward without a matching fix. CLOSE_THRESHOLD_MS is a judgment call
    // (flagged in the handoff): 5 minutes, generous enough to cover a slow batch extraction between
    // the scan finishing and the fix landing.
    const CLOSE_THRESHOLD_MS = 5 * 60 * 1000;
    const checkedMs = item.lastChecked ? new Date(item.lastChecked).getTime() : null;
    const fixedMs = item.lastFixed ? new Date(item.lastFixed).getTime() : null;
    let statusText = '';
    if (checkedMs && fixedMs && Math.abs(fixedMs - checkedMs) <= CLOSE_THRESHOLD_MS) {
      statusText = ` — Last extracted: ${new Date(item.lastFixed).toLocaleString()}`;
    } else {
      const parts = [];
      if (checkedMs) parts.push(`Last checked: ${new Date(item.lastChecked).toLocaleString()}`);
      if (fixedMs) parts.push(`Last extracted: ${new Date(item.lastFixed).toLocaleString()}`);
      if (parts.length) statusText = ` — ${parts.join(' — ')}`;
    }
    const subLine = el('div', { class: 'sub' }, `${item.modCount} mod${item.modCount === 1 ? '' : 's'}${statusText}`);
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

// "which ones?" expander state -- collapses again whenever the pick set changes back to empty
// (nothing left to show) or a fresh render happens; doesn't try to preserve open/closed across a
// pick-count change otherwise, same as the mockup this was approved from.
let rmfCartTagsOpen = false;

function rmfUpdatePickCount() {
  const n = rmfState.picked.size;
  $g('rmfPickCountNum').textContent = String(n);
  $g('rmfPickCountPlural').textContent = n === 1 ? '' : 's';
  $g('rmfScanBtn').disabled = n === 0;

  const toggleBtn = $g('rmfCartToggleBtn');
  toggleBtn.hidden = n === 0;
  if (n === 0) rmfCartTagsOpen = false;

  const tagList = $g('rmfCartTagList');
  tagList.classList.toggle('open', rmfCartTagsOpen);
  tagList.innerHTML = '';
  for (const id of rmfState.picked) {
    const name = rmfState.collectionsById.get(id)?.name || id;
    const tag = el('span', { class: 'rmf-cartbar__tag' }, [name]);
    const removeBtn = el('button', { title: 'Remove' }, '×');
    removeBtn.addEventListener('click', () => {
      rmfState.picked.delete(id);
      const checkbox = document.querySelector(`.coll-card input[type="checkbox"][data-mod-id="${id}"]`);
      if (checkbox) { checkbox.checked = false; checkbox.closest('.coll-card').classList.remove('sel'); }
      rmfUpdatePickCount();
    });
    tag.appendChild(removeBtn);
    tagList.appendChild(tag);
  }
}

$g('rmfCartToggleBtn').addEventListener('click', () => {
  rmfCartTagsOpen = !rmfCartTagsOpen;
  rmfUpdatePickCount();
});

$g('rmfScanBtn').addEventListener('click', rmfStartScan);
// Real cancel (2026-08-25) -- this is the only "back" control shown during a scan (director's own
// "no cancel button while scanning" report), so it needs to actually stop the in-flight scan, not
// just hide the view. Without this, a scan already in progress kept delivering 'mod-scanned'/
// 'scan-complete' events after the user navigated away, silently re-showing the report underneath
// them the moment it finished. The scan itself is read-only (see rmfStartScan's own pre-scan note),
// so there's nothing to undo server-side -- closing the client's own EventSource is enough to make
// "Cancel" genuinely mean cancel.
$g('rmfBackToPickerBtn').addEventListener('click', () => {
  if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
  $g('rmfScanLoading').classList.add('hidden');
  $g('rmfReportView').classList.add('hidden');
  $g('rmfPickerView').classList.remove('hidden');
  rmfSetBackBtnState('results');
  rmfRenderStepper(0);
});

// Same button does triple duty -- Cancel while a scan is actively running, plain "Back" while
// reviewing scan results (Step 2), "Back to Collections" once Done (Step 3). Replaces the old
// two-state "Cancel"/"← Check Different Collections" toggle (director's own correction, 2026-09-01:
// "pretty sure we removed that and use back buttons now") with this app's standard nav-button
// convention -- plain ghost "Back" matching frBackBtn/chHistoryCancelBtn/ucv2CancelReviewBtn, and
// "Back to Collections" (btn--primary) matching ucv2ApplyResultBackBtn exactly for the completed-
// result state. Label/class only; the click handler above already does the real work (close the
// EventSource) regardless of which state is currently showing.
function rmfSetBackBtnState(state) {
  const btn = $g('rmfBackToPickerBtn');
  if (state === 'scanning') {
    btn.textContent = 'Cancel';
    btn.className = 'btn btn--ghost btn--small';
  } else if (state === 'done') {
    btn.textContent = 'Back to Collections';
    btn.className = 'btn btn--primary';
  } else {
    btn.textContent = 'Back';
    btn.className = 'btn btn--ghost btn--small';
  }
}

// Flips true the moment a real staging-folder write happens (an extract with restoredFiles > 0) --
// reset at the start of every fresh scan and on reset-on-entry, so it always reflects only THIS
// scan-to-done run. Gates the new Deploy prompt (rmfSetDoneUI below): a clean scan that found
// nothing missing, or a Download Archive that resolves an archive-missing row without ever needing
// to extract anything (download-archive only writes to the downloads folder, never staging -- see
// its own route comment in web/rebuild-missing-routes.js), has nothing new for Vortex to deploy from
// this tool's own action, so it shouldn't offer to.
let rmfAnyRestoreThisRun = false;

// Groups the Done-state-only UI changes that always move together once hasActionable flips to false
// (director's own catches, 2026-09-01): the live remaining-count stat grid and the Missing/Ignored/
// Show-all filter pills both go stale/misleading once nothing is left to act on, so both hide; the
// nav button switches to "Back to Collections"; and the new real Deploy prompt shows, but ONLY when
// this run actually restored something (see rmfAnyRestoreThisRun above) -- never for a plain "nothing
// was missing" landing. Reverts every one of these the moment `done` is false again (still reviewing).
function rmfSetDoneUI(done, offerDeploy) {
  $g('rmfStatGrid').classList.toggle('hidden', done);
  $g('rmfSummaryBadges').classList.toggle('hidden', done);
  rmfSetBackBtnState(done ? 'done' : 'results');
  $g('rmfDeployPending').classList.toggle('hidden', !(done && offerDeploy));
  if (!done) {
    $g('rmfDeployProgress').classList.add('hidden');
    $g('rmfDeployResult').classList.add('hidden');
  }
}

// ---------- Scan (Screen 2) ----------

async function rmfStartScan() {
  $g('rmfPickerView').classList.add('hidden');
  $g('rmfReportView').classList.remove('hidden');
  $g('rmfResults').classList.add('hidden');
  // rmfActionsHelp is a SIBLING of rmfResults, not a child (real bug found live 2026-08-25) --
  // hiding rmfResults alone left this showing throughout the whole scan, above an otherwise-empty
  // screen with nothing yet to select or extract.
  $g('rmfActionsHelp').classList.add('hidden');
  $g('rmfScanError').classList.add('hidden');
  $g('rmfRefreshFailuresCallout').classList.add('hidden');
  $g('rmfScanLoading').classList.remove('hidden');
  $g('rmfScanLoadingText').textContent = 'Starting scan…';
  rmfSetBackBtnState('scanning');
  rmfAnyRestoreThisRun = false; // a fresh scan starts a new run -- see its own header comment
  rmfRenderStepper(1, true);

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
      rmfSetBackBtnState('results');
      rmfHandleError(e, $g('rmfScanError'), rmfStartScan);
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
    // No rmfSetBackBtnState call here -- rmfRenderReport below always calls rmfSetDoneUI itself,
    // which sets the real final back-button state (done vs. still reviewing) based on the actual
    // results, superseding any intermediate value this line could set.
    if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
    rmfRenderReport(frame.collectionResults, frame.stats, frame.refreshFailures);
  } else if (frame.type === 'scan-error') {
    $g('rmfScanLoading').classList.add('hidden');
    rmfSetBackBtnState('results');
    if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
    rmfHandleError(new Error(frame.message || 'The scan failed.'), $g('rmfScanError'), rmfStartScan);
  }
}

function rmfRenderReport(collectionResults, stats, refreshFailures) {
  rmfState.rows = [];
  rmfState.selected = new Set();
  rmfResetKindFilterToDefault(); // a fresh scan starts clean -- same reset as rmfState.selected above
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
    // A mod Ignored in Vortex is never added as a row at all (2026-09-02, director's own direct ask
    // -- "we don't need to show mods that are ignored"). Server already reclassified it out of
    // modsWithMissing/modsArchiveMissing, so stats.modsWithMissing/filesMissing below never counted
    // it either -- c.modsIgnored is deliberately left unread here, not just filtered client-side.
    // A mod on the Mod Exceptions list (queue: rebuild-missing-hand-pick-exceptions) -- server
    // never even scanned it (see missing-files-scan.js's own SKIP_EXCEPTED early-out). Same
    // acknowledged tier as modsIgnored above, distinct reason text.
    for (const mod of c.modsExcepted || []) {
      rmfState.rows.push({ kind: 'excepted', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
    }
  }

  $g('rmfResults').classList.remove('hidden');
  $g('rmfStatColls').textContent = stats.collectionsChecked;
  $g('rmfStatMods').textContent = stats.modsWithMissing;
  $g('rmfStatFiles').textContent = stats.filesMissing;

  // Real gap fixed 2026-08-25: the table/selection controls/action-help used to hide only when
  // rmfState.rows was LITERALLY empty -- but rows also includes the 'excepted' kind, which is
  // informational-only (its own checkbox is disabled, nothing to select or extract). A
  // collection with nothing actionable left except those still showed the whole active-work UI
  // (Select All, Extract Selected, the table) for nothing to act on. hasActionable is the real
  // condition for "is there still work to do here" -- trulyEmpty is reserved for the plain
  // "literally nothing at all" case (rmfAllClearCallout).
  const hasActionable = rmfState.rows.some((r) => r.kind === 'missing' || r.kind === 'archive-missing');
  const trulyEmpty = rmfState.rows.length === 0;
  rmfRenderStepper(hasActionable ? 1 : 2);
  // A fresh scan reaching Done here never has anything of ITS OWN to deploy (offerDeploy false) --
  // rmfAnyRestoreThisRun was already reset to false at the start of this scan (rmfStartScan), so this
  // is really just documenting the intent, not relying on incidental ordering.
  rmfSetDoneUI(!hasActionable, rmfAnyRestoreThisRun);
  // filesMissing/modsWithMissing only ever count 'missing' rows -- an 'archive-missing' row (its
  // files can't even be checked yet without the archive) never adds to either. So hasActionable-but-
  // filesMissing-0 is a real case (archive issues only) and the "0 files are missing across 0 mods"
  // wording was flatly wrong there -- confirmed live 2026-08-25. The per-row "⚠️ {reason}" note and
  // the "N Archive Issue(s)" filter badge above already cover that case, so just skip the summary
  // callout entirely rather than inventing a second banner that duplicates them.
  const showSummary = stats.filesMissing > 0;
  $g('rmfAllClearCallout').classList.toggle('hidden', !trulyEmpty);
  $g('rmfSummaryCallout').classList.toggle('hidden', trulyEmpty || (hasActionable && !showSummary));
  $g('rmfSelectionBar').classList.toggle('hidden', !hasActionable);
  $g('rmfTableWrap').classList.toggle('hidden', !hasActionable);
  $g('rmfActionsHelp').classList.toggle('hidden', !hasActionable);
  $g('rmfExtractResultsCallout').classList.add('hidden');
  if (!trulyEmpty && (!hasActionable || showSummary)) {
    const summary = $g('rmfSummaryCallout');
    if (!hasActionable) {
      // "External Changes" static note removed from here (2026-09-01) -- this branch fires on a
      // FRESH scan that found nothing missing, so this tool never wrote anything this run; there was
      // never a real trigger for Vortex's own dialog to begin with (pre-existing bug: the note used
      // to show here unconditionally even though nothing was restored -- director's own catch).
      summary.className = 'callout callout--success';
      summary.innerHTML = '<div class="callout__title">🎉 No Missing Files Detected</div>'
        + '<p>All mods are complete. No repairs are needed in your staging folder. Open Vortex and click <strong>Deploy Mods</strong> to apply the changes.</p>';
    } else {
      summary.className = 'callout callout--warning';
      summary.innerHTML =
        `<b>${stats.filesMissing} file${stats.filesMissing === 1 ? '' : 's'}</b> ${stats.filesMissing === 1 ? 'is' : 'are'} missing across ` +
        `<b>${stats.modsWithMissing} mod${stats.modsWithMissing === 1 ? '' : 's'}</b>. Fixing these only updates your staging folder — ` +
        `open Vortex and click <strong>Deploy Mods</strong> afterward.`;
    }
  }
  rmfRenderRows();
}

// ---------- Filter badges (Select All/Clear Selection's own row-kind filter) ----------
// Same clickable filter-badge convention as Missing Masters' own mmSummaryBadges/mmStatusFilter
// and Stats Report's statsIssuesBadges -- copied, not reinvented (queue: rebuild-missing-filter-badges).
// "Archive Issue" (not "Archive Missing") covers both real reasons a row can land here -- no
// archive found at all, or one was found but couldn't be confirmed as the right one -- which
// "Archive Missing" alone would misdescribe for the second case, even though the row itself
// (rmfBuildMissingCell) no longer spells either reason out (2026-09-02 v5 addendum: just "Missing
// archive", the per-row Download Archive action covers both cases identically either way).
const RMF_KIND_INFO = {
  missing: { label: 'Missing', badgeClass: 'badge--critical' },
  'archive-missing': { label: 'Archive Issue', badgeClass: 'badge--warning' },
  // Mod Exceptions list (queue: rebuild-missing-hand-pick-exceptions) -- DESIGN.md's own fifth,
  // non-severity "acknowledged" tier (grey, informational, not a problem) -- a deliberate, standing
  // opt-out this director set, not something Vortex itself reports.
  excepted: { label: 'Excepted', badgeClass: 'badge--neutral' },
};

// A Set of active kinds -- empty shows everything. Multi-select: each badge toggles independently
// and the shown rows are the UNION of every active kind, not "isolate to just one" (workspace
// UX-PRINCIPLES.md rule 7: "Filters are multi-select toggles... combine (the list shows the
// union)... Not single-select-one-at-a-time." -- confirmed real 2026-08-15, this file along with
// every other clickable filter-badge in the app was single-select only until this pass).
// Defaults to just the "Missing" pill active (not "Show all") -- director's own direct ask,
// 2026-09-01: Missing is the actionable category (the one Restore Selected Files can fix), so it's
// the more useful thing to land on than an unfiltered list that also mixes in Archive Issue/Ignored/
// Excepted rows. rmfResetKindFilterToDefault() (not a bare .clear()) is used everywhere this filter
// gets reset (fresh scan, reset-on-entry) so the default stays in one place.
let rmfKindFilter = new Set(['missing']);
function rmfResetKindFilterToDefault() {
  rmfKindFilter = new Set(['missing']);
}

function rmfRenderSummaryBadges() {
  const badgesEl = $g('rmfSummaryBadges');
  badgesEl.innerHTML = '';
  if (rmfState.rows.length === 0) return; // nothing to filter when the list itself is empty
  const counts = {};
  for (const row of rmfState.rows) counts[row.kind] = (counts[row.kind] || 0) + 1;
  // Fixed order (missing first -- the category fixable right here) rather than object insertion
  // order, so pills don't reshuffle position as counts change between renders.
  for (const key of ['missing', 'archive-missing', 'excepted']) {
    if (!counts[key]) continue;
    const info = RMF_KIND_INFO[key];
    const active = rmfKindFilter.has(key);
    const badge = el('span', {
      class: `badge ${info.badgeClass} badge--clickable${active ? ' badge--filter-active' : ''}`,
      'data-kind': key,
    }, [el('span', { class: 'badge__count' }, String(counts[key])), ' ' + info.label]);
    badge.addEventListener('click', () => {
      if (active) rmfKindFilter.delete(key); else rmfKindFilter.add(key);
      rmfRenderRows();
    });
    badgesEl.appendChild(badge);
  }
  const showAll = el('span', { class: `badge badge--show-all${rmfKindFilter.size === 0 ? ' badge--filter-active' : ''}` }, 'Show all');
  showAll.addEventListener('click', () => {
    rmfKindFilter.clear();
    rmfRenderRows();
  });
  badgesEl.appendChild(showAll);
}

function rmfRenderRows() {
  // Judgment call (flagged, not silently copied from Missing Masters): if an ACTIVE filter's own
  // category count just dropped to 0 (everything in it got fixed via Extract/Download Archive),
  // drop just that one kind from the filter rather than leaving the user staring at a stale badge
  // that no longer means anything -- other active kinds (if any, now that this is multi-select)
  // stay untouched. Missing Masters' own mmRenderMasterList doesn't do this -- it just shows an
  // empty-state message and leaves the stale filter active, which reads as "did my fix not work?"
  // rather than "you fixed all of these." Recomputed every render (not just once) so counts always
  // reflect the live row set, per this task's own scope item 5.
  for (const key of [...rmfKindFilter]) {
    if (!rmfState.rows.some((r) => r.kind === key)) rmfKindFilter.delete(key);
  }
  rmfRenderSummaryBadges();

  const tbody = $g('rmfRows');
  tbody.innerHTML = '';
  // Filtered by original index, not the filtered array's own local index -- rmfState.selected and
  // every action handler below key off the row's real position in rmfState.rows, unaffected by
  // which rows are currently visible (a hidden row keeps its selection state, same as Archive
  // Finder's own "Show selected only" toggle already does).
  // Multi-select: empty filter shows everything; a non-empty filter shows the UNION of every
  // active kind (workspace UX-PRINCIPLES.md rule 7), not "isolate to exactly one".
  const entries = rmfState.rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => rmfKindFilter.size === 0 || rmfKindFilter.has(row.kind));
  entries.forEach(({ row, idx }) => {
    const tr = el('tr', { 'data-idx': String(idx) });
    // Acknowledged tier (DESIGN.md's own fifth, non-severity tier) -- muted grey row, same
    // background/left-edge treatment as the "selected" state below but with --neutral instead of
    // --accent (see .row--ignored in styles.css). A mod on the Exceptions list looks like a problem
    // at a glance otherwise; this downgrades it the same way Missing Masters' own mm-row--soft does.
    if (row.kind === 'excepted') tr.classList.add('row--ignored');
    tr.classList.toggle('selected', rmfState.selected.has(idx));

    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = rmfState.selected.has(idx);
    // archive-missing is checkable too (2026-09-02 v5 addendum, reversing the same-day Issues-panel
    // detour) -- selecting it and clicking the batch action downloads its archive from Nexus then
    // extracts, same chain the per-row Download Archive button already runs on its own.
    checkbox.disabled = row.kind !== 'missing' && row.kind !== 'archive-missing';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) rmfState.selected.add(idx);
      else rmfState.selected.delete(idx);
      tr.classList.toggle('selected', checkbox.checked);
      rmfRefreshSelectionUI();
    });
    tr.appendChild(el('td', {}, checkbox));

    // A domainName is only ever set on a mod cross-listed under a different game's own Nexus catalog
    // -- surface it right next to the name (confirmed real 2026-08-25: "TES Arena Bikini Armor" sits
    // in an SE collection but is hosted under Legacy Skyrim's own domain), since it's genuinely
    // useful context, not noise -- the overwhelming majority of mods never show this at all.
    const nameNode = row.domainName
      ? el('div', { class: 'mod' }, [row.name + ' ', el('span', { class: 'muted' }, `(${row.domainName})`)])
      : el('div', { class: 'mod' }, row.name);
    const modCell = el('td', {}, [nameNode]);
    // archive-missing's own reason text used to show here (2026-09-01 wording) -- dropped entirely
    // per the director's direct ask (2026-09-02 v5 addendum): the "Missing files" cell's own
    // "Missing archive" pill (rmfBuildMissingCell) already says everything needed at a glance; the
    // fuller reason was this session's own invention, not something asked for, and he wants it gone,
    // not hidden as a tooltip either.
    if (row.kind === 'excepted') {
      modCell.appendChild(el('div', { class: 'ignored-note' }, `⚪ On the ${rmfExceptionsName()} list -- never auto-fixed here.`));
    }
    tr.appendChild(modCell);

    tr.appendChild(el('td', { class: 'muted' }, row.version || '—'));

    tr.appendChild(el('td', { class: 'coll-tag muted' }, row.collectionName));

    tr.appendChild(el('td', {}, rmfBuildMissingCell(row, idx)));

    tr.appendChild(el('td', {}, rmfBuildActionsCell(row, idx)));

    tbody.appendChild(tr);
  });
  rmfRefreshSelectionUI();
}

// One file per line (not a comma-joined run-on), collapsed to the first 4 with the same "+N more /
// Show less" toggle every other long list in this app already uses (director's own direct ask,
// 2026-09-01) -- was 6 and comma-joined; lowered to 4 to match.
const RMF_FILE_LIST_TRUNCATE_AT = 4;
function rmfBuildMissingCell(row, idx) {
  // Plain phrase, no reason text (2026-09-02 v5 addendum, director's direct ask: "just say Missing
  // archive - done") -- a warning-colored status-pill, same treatment as the 'missing' cell's own
  // "{N} missing" pill just below, for visual consistency between the two row kinds sharing this
  // column (the mockup's own v5 addendum shows it as a pill too, not a plain muted line).
  if (row.kind === 'archive-missing') {
    return el('span', { class: 'status-pill status-pill--warning' }, 'Missing archive');
  }
  if (row.kind === 'excepted') {
    return el('span', { class: 'muted' }, `Not checked — on the ${rmfExceptionsName()} list.`);
  }
  const wrap = el('div', { class: 'detail-cell' }, [
    el('span', { class: 'status-pill status-pill--critical' }, row.notInstalled ? 'Not installed' : `${row.missing.length} missing`),
  ]);
  const shown = row.missing.slice(0, RMF_FILE_LIST_TRUNCATE_AT).map((f) => f.destination);
  const rest = row.missing.slice(RMF_FILE_LIST_TRUNCATE_AT).map((f) => f.destination);
  const list = el('div', { class: 'file-list' });
  shown.forEach((path) => list.appendChild(el('div', { class: 'file-list-item' }, path)));
  if (rest.length > 0) {
    const extra = el('div', { class: 'file-list-extra hidden' });
    rest.forEach((path) => extra.appendChild(el('div', { class: 'file-list-item' }, path)));
    const toggle = el('a', { class: 'file-list-toggle', 'data-more': `+${rest.length} more`, 'data-less': 'Show less' }, `+${rest.length} more`);
    list.appendChild(extra);
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
    actions.appendChild(rmfBuildExceptionBtn(row));
  } else if (row.kind === 'excepted') {
    // Acknowledged tier -- nothing to fix here, so no action buttons at all (DESIGN.md's own rule:
    // showing a "here's how to fix it" button next to a row that says "nothing to fix" reads as a
    // contradiction). Left empty rather than a placeholder note -- the mod-name cell's own
    // "⚪ {reason}" note already says why.
  } else if (row.modId != null) {
    const dlBtn = el('button', { class: 'btn btn--small' }, 'Download Archive');
    dlBtn.addEventListener('click', () => rmfDownloadArchive(row, idx, dlBtn));
    actions.appendChild(dlBtn);
    actions.appendChild(rmfBuildExceptionBtn(row));
  } else {
    actions.appendChild(el('span', { class: 'muted', style: 'font-size:12px' }, 'Not on Nexus — download manually'));
    actions.appendChild(rmfBuildExceptionBtn(row));
  }
  return actions;
}

// "Add to Exception List" (queue: rebuild-missing-hand-pick-exceptions) -- offered on every
// 'missing'/'archive-missing' row (real case this exists for: a hand-pick-only FOMOD, e.g.
// "1DustAdeptArmorSE", where auto-extracting/auto-rebuilding the full archive would install
// content the user never chose). A ghost btn, not primary -- this is an opt-out action, not the
// row's main "fix it" action (Extract from Archive/Download Archive keep that spot).
function rmfBuildExceptionBtn(row) {
  const btn = el('button', { class: 'btn btn--ghost btn--small' }, 'Add to Exception List');
  btn.addEventListener('click', () => rmfAddException(row, btn));
  return btn;
}

async function rmfAddException(row, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Adding…';
  try {
    await rmfApi('POST', '/api/mod-exceptions/add', { name: row.name, modId: row.modId ?? null });
    // Re-classify this ONE row as excepted in place, same "no need for a full re-scan" treatment
    // as rmfApplyExtractResults/rmfDownloadArchive already give their own row updates.
    const idx = rmfState.rows.indexOf(row);
    if (idx !== -1) {
      // Same stat-refresh treatment as rmfApplyExtractResults' own -- only a 'missing' row ever
      // counted toward rmfStatFiles/rmfStatMods (an 'archive-missing' row never did), so only
      // decrement when that's what this row was.
      if (row.kind === 'missing') {
        const statFiles = Math.max(0, Number($g('rmfStatFiles').textContent) - row.missing.length);
        $g('rmfStatFiles').textContent = statFiles;
      }
      rmfState.rows[idx] = { kind: 'excepted', collectionModId: row.collectionModId, collectionName: row.collectionName, name: row.name, version: row.version ?? null, modId: row.modId ?? null, fileId: row.fileId ?? null, reason: `On the ${rmfExceptionsName()} list -- never auto-fixed here. Remove it from its own report if you want this tool to manage it again.` };
      rmfState.selected.delete(idx);
      rmfRenderRows();
      $g('rmfStatMods').textContent = rmfState.rows.filter((r) => r.kind === 'missing').length;
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(e, $g('rmfScanError'), () => rmfAddException(row, btn));
  }
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

// row.kind === 'missing' || 'archive-missing' -- the two selectable kinds (2026-09-02 v5 addendum).
// A small helper since this same pair check now recurs across every selection action below.
function rmfIsSelectable(row) { return row.kind === 'missing' || row.kind === 'archive-missing'; }

function rmfRefreshSelectionUI() {
  const selectableCount = rmfState.rows.filter(rmfIsSelectable).length;
  const n = rmfState.selected.size;
  $g('rmfSelCount').textContent = `${n} of ${selectableCount} selected`;
  $g('rmfExtractSelectedBtn').disabled = n === 0;
}

$g('rmfSelectAllBtn').addEventListener('click', () => {
  rmfState.rows.forEach((r, idx) => { if (rmfIsSelectable(r)) rmfState.selected.add(idx); });
  rmfRenderRows();
});
$g('rmfClearBtn').addEventListener('click', () => {
  rmfState.selected.clear();
  rmfRenderRows();
});
$g('rmfInvertBtn').addEventListener('click', () => {
  rmfState.rows.forEach((r, idx) => {
    if (!rmfIsSelectable(r)) return;
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
  // Split into the two things a mixed batch can actually do -- extract-only rows already have a
  // resolved local archive; archive-missing rows need a real Nexus download first. Said honestly
  // instead of describing every row as a plain extraction (2026-09-02 v5 addendum).
  const fileCount = indices.reduce((n, i) => n + (rmfState.rows[i].missing?.length || 0), 0);
  const archiveCount = indices.filter((i) => rmfState.rows[i].kind === 'archive-missing').length;
  const bits = [];
  if (fileCount > 0) bits.push(`restores ${fileCount} missing file${fileCount === 1 ? '' : 's'}`);
  if (archiveCount > 0) bits.push(`downloads ${archiveCount} missing archive${archiveCount === 1 ? '' : 's'} from Nexus, then extracts ${archiveCount === 1 ? 'it' : 'them'}`);
  $g('rmfExtractConfirmModalText').textContent =
    `This ${bits.join(' and ')} across ${indices.length} mod${indices.length === 1 ? '' : 's'}. ` +
    `It only adds back what's missing — nothing else in your staging folder is touched.`;
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

// Named (not just an inline listener body) so a Vortex-running retry -- from either the initial
// POST failing or the SSE stream itself later reporting extract-error -- can re-run the exact same
// extraction for the same `indices`, rather than leaving Try Again a no-op (queue: rebuild-missing-
// vortex-retry-noop).
async function rmfDoExtract(indices) {
  const items = indices.map((i) => {
    const row = rmfState.rows[i];
    // collectionModId (queue: rebuild-missing-last-fixed) -- lets the server mark the right
    // collection(s) "dealt with" once at least one file in this batch is actually extracted.
    // kind carries through so the batch route knows which rows need a real Nexus download first
    // (2026-09-02 v5 addendum) -- archive-missing rows have no local archivePath/files to extract
    // from yet, just enough to resolve the mod and download it (same {collectionModId, modId,
    // fileId} shape the single-row Download Archive action already sends).
    return row.kind === 'archive-missing'
      ? { kind: 'archive-missing', name: row.name, collectionModId: row.collectionModId, modId: row.modId, fileId: row.fileId }
      : { kind: 'missing', name: row.name, targetFolderName: row.targetFolderName, archivePath: row.archivePath, files: row.missing, collectionModId: row.collectionModId };
  });
  $g('rmfExtractResultsCallout').classList.add('hidden');
  rmfSetExtractingUI(true);
  $g('rmfExtractLoadingText').textContent = 'Restoring files…';
  try {
    await rmfApi('POST', '/api/rebuild-missing/extract', { items });
  } catch (e) {
    rmfSetExtractingUI(false);
    rmfHandleError(e, $g('rmfScanError'), () => rmfDoExtract(indices));
    return;
  }
  if (rmfState.extractEventSource) rmfState.extractEventSource.close();
  const es = new EventSource('/api/rebuild-missing/extract/events');
  rmfState.extractEventSource = es;
  es.onmessage = (msg) => rmfHandleExtractEvent(JSON.parse(msg.data), indices);
}

$g('rmfExtractConfirmOkBtn').addEventListener('click', () => {
  $g('rmfExtractConfirmModal').classList.add('hidden');
  rmfDoExtract(rmfPendingExtractIndices);
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
    rmfHandleError(new Error(frame.message || 'The extraction failed.'), $g('rmfScanError'), () => rmfDoExtract(indices));
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
      if (row.kind === 'missing') {
        row.missing = row.missing.filter((f) => !(result.extracted || []).includes(f.destination));
      } else {
        // archive-missing, resolved via the shared download-then-extract chain -- nothing left to
        // track on this row (2026-09-02 v5 addendum).
        row._resolved = true;
      }
      rmfState.selected.delete(idx);
    } else {
      failures.push(`${row.name}: ${result.error}`);
    }
  });
  // Rows with nothing left missing (or a resolved archive-missing row) drop out of the report
  // entirely -- rebuild the row list rather than just re-rendering in place, since indices shift
  // once any row is removed.
  rmfState.rows = rmfState.rows.filter((r) => !(r.kind === 'missing' && r.missing.length === 0) && !r._resolved);
  rmfState.selected = new Set();

  const callout = $g('rmfExtractResultsCallout');
  // Combined into ONE banner (2026-08-25, director's own request) when this extract resolved
  // everything -- the separate "Nothing missing" callout below used to show redundantly right next
  // to this one saying almost the same thing. rmfAllClearCallout stays reserved for the OTHER case
  // (a fresh scan that never had anything missing at all -- rmfRenderReport above, untouched).
  // Gated on hasActionable (2026-09-02 fix), not the stricter "rows.length === 0" -- a run that still
  // has 'excepted' rows left (rows.length > 0) but nothing ACTIONABLE remaining already reaches the
  // real Done UI (rmfSetDoneUI below, stat grid/badges hidden, Deploy prompt shown) --
  // the old rows-length check kept showing the plain pre-Deploy-button wording in exactly that case,
  // caught live by the director on a real 13,016-file/5-mod restore that still had excepted rows.
  const hasActionableAfterExtract = rmfState.rows.some((r) => r.kind === 'missing' || r.kind === 'archive-missing');
  if (failures.length === 0) {
    callout.className = 'callout callout--success';
    // Exact copy per director's own spec, 2026-09-02 (revised from the 2026-09-01 wording) -- this
    // tool has its own real Deploy button right below (#rmfDeployPending), so the copy points at that
    // instead of Vortex's own Deploy Mods.
    callout.innerHTML = !hasActionableAfterExtract
      ? `<div class="callout__title">🎉 Restoration Complete!</div><p>Successfully restored ${restoredFiles.toLocaleString()} file${restoredFiles === 1 ? '' : 's'} across ${restoredMods} mod${restoredMods === 1 ? '' : 's'}. Click <strong>Deploy</strong> to finish, or select another collection to restore more mods.</p>`
      : `Restored ${restoredFiles.toLocaleString()} file${restoredFiles === 1 ? '' : 's'} across ${restoredMods} mod${restoredMods === 1 ? '' : 's'}. Open Vortex and click Deploy Mods to finish.`;
  } else {
    callout.className = 'callout callout--warning';
    callout.innerHTML = `<div class="callout__title">⚠️ Restored some files with problems</div><p>Restored ${restoredFiles} file${restoredFiles === 1 ? '' : 's'} across ${restoredMods} mod${restoredMods === 1 ? '' : 's'}, but ${failures.length} mod${failures.length === 1 ? '' : 's'} had a problem: ${failures.join('; ')}</p>`;
  }
  callout.classList.remove('hidden');
  if (restoredFiles > 0) rmfAnyRestoreThisRun = true; // gates the Deploy prompt below -- see its own header comment
  rmfRenderRows();

  const statFiles = Math.max(0, Number($g('rmfStatFiles').textContent) - restoredFiles);
  const statMods = rmfState.rows.filter((r) => r.kind === 'missing').length;
  $g('rmfStatFiles').textContent = statFiles;
  $g('rmfStatMods').textContent = statMods;
  // Same hasActionable fix as rmfRenderReport above -- ignored/excepted rows shouldn't keep the
  // active-work UI (Select All, Extract Selected, the table) showing once nothing is actually
  // selectable anymore.
  const hasActionable = rmfState.rows.some((r) => r.kind === 'missing' || r.kind === 'archive-missing');
  rmfRenderStepper(hasActionable ? 1 : 2);
  rmfSetDoneUI(!hasActionable, rmfAnyRestoreThisRun);
  // Both always hidden here -- "nothing missing"/"still missing" is folded into this function's own
  // extract-results callout above (allDone vs. partial), not rmfAllClearCallout/rmfSummaryCallout --
  // those belong to the fresh-scan path in rmfRenderReport and are never given fresh content here.
  $g('rmfAllClearCallout').classList.add('hidden');
  $g('rmfSummaryCallout').classList.add('hidden');
  $g('rmfSelectionBar').classList.toggle('hidden', !hasActionable);
  $g('rmfTableWrap').classList.toggle('hidden', !hasActionable);
  $g('rmfActionsHelp').classList.toggle('hidden', !hasActionable);
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

    // Real gap fixed 2026-08-25: a Download Archive that resolves the LAST actionable row (this
    // mod's archive turns out to have nothing missing -- result.bucket === 'ok', the row is just
    // dropped above) used to leave the active-work UI (Select All bar, empty table) sitting there
    // with nothing left to act on, instead of switching to the same "all clear" success screen a
    // fresh scan or a completed Extract already shows. Same hasActionable recompute as
    // rmfRenderReport/the extract handler above.
    const hasActionable = rmfState.rows.some((r) => r.kind === 'missing' || r.kind === 'archive-missing');
    rmfRenderStepper(hasActionable ? 1 : 2);
    // offerDeploy reflects rmfAnyRestoreThisRun, not "this download alone" -- Download Archive only
    // ever writes to the downloads folder, never staging (see its own route comment), so on its own
    // it has nothing new for Vortex to deploy. Still respects an earlier Extract elsewhere in the
    // SAME run (a mixed session), rather than hardcoding false here.
    rmfSetDoneUI(!hasActionable, rmfAnyRestoreThisRun);
    $g('rmfSelectionBar').classList.toggle('hidden', !hasActionable);
    $g('rmfTableWrap').classList.toggle('hidden', !hasActionable);
    $g('rmfActionsHelp').classList.toggle('hidden', !hasActionable);
    if (!hasActionable) {
      const summary = $g('rmfSummaryCallout');
      summary.className = 'callout callout--success';
      summary.innerHTML = '<div class="callout__title">🎉 No Missing Files Detected</div>'
        + '<p>All mods are complete. No repairs are needed in your staging folder. Open Vortex and click <strong>Deploy Mods</strong> to apply the changes.</p>';
      summary.classList.remove('hidden');
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(e, $g('rmfScanError'), () => rmfDownloadArchive(row, idx, btn));
  }
}

// ---------- Open Staging Folder ----------

async function rmfOpenStagingFolder(row) {
  try {
    await rmfApi('POST', '/api/rebuild-missing/open-staging-folder', { targetFolderName: row.targetFolderName });
  } catch (e) {
    rmfHandleError(e, $g('rmfScanError'), () => rmfOpenStagingFolder(row));
  }
}

// ---------- Deploy (Done state, 2026-09-01) ----------
// Real fire-and-poll deploy, replacing the old static "External Changes" warning -- director's own
// ask: "add Deploy button... replace with our standard deploy modal used elsewhere (Update
// collection)." Modeled on Missing Masters' own mmDeployAll (missing-masters-app.js) -- a real
// progress bar + phase text polled from Vortex's own deploy status, not a fake animation, with a
// genuine Retry Deploy affordance on failure -- rather than Update Collection v2's richer
// stall-hint version; this tool's own scale doesn't need that extra complexity, and mmDeployAll's
// simpler setInterval loop is a cleaner fit. Backed by the exact same generic
// helperClient.deployAllMods()/getDeployAllProgress() pair every one of these deploy buttons in this
// app already shares (see web/rebuild-missing-routes.js's own /deploy-all + /deploy-all/progress,
// mirroring missing-masters-routes.js's).
let rmfDeployPollInterval = null;
function rmfStopDeployPolling() {
  if (rmfDeployPollInterval) { clearInterval(rmfDeployPollInterval); rmfDeployPollInterval = null; }
}

function rmfShowDeployResult(kind) {
  const box = $g('rmfDeployResult');
  box.classList.remove('hidden');
  box.className = `callout callout--${kind === 'success' ? 'success' : 'warning'}`;
  box.innerHTML = '';
  if (kind === 'success') {
    box.appendChild(el('div', { class: 'callout__title' }, '✅ Deploy complete — your game is ready to launch.'));
    return;
  }
  box.appendChild(el('div', { class: 'callout__title' }, '⚠️ Deploy failed'));
  box.appendChild(el('p', {}, 'Vortex could not complete the deployment. You can try again from here, or open Vortex and click Deploy Mods directly.'));
  const retry = el('button', { class: 'btn btn--primary btn--small' }, 'Retry Deploy');
  retry.addEventListener('click', () => rmfStartDeploy());
  box.appendChild(el('div', { class: 'row-actions' }, retry));
}

async function rmfStartDeploy() {
  $g('rmfDeployResult').classList.add('hidden');
  $g('rmfDeployPending').classList.add('hidden');
  $g('rmfDeployProgress').classList.remove('hidden');
  $g('rmfDeployPhase').textContent = 'Starting…';
  $g('rmfDeployBar').style.width = '0%';

  try {
    await rmfApi('POST', '/api/rebuild-missing/deploy-all', {});
  } catch (e) {
    $g('rmfDeployProgress').classList.add('hidden');
    rmfShowDeployResult('error');
    return;
  }

  rmfStopDeployPolling();
  rmfDeployPollInterval = setInterval(async () => {
    let progress;
    try {
      progress = await rmfApi('GET', '/api/rebuild-missing/deploy-all/progress');
    } catch {
      return; // one failed poll is not evidence the deploy failed -- try again next tick
    }
    if (progress && typeof progress.percent === 'number') {
      $g('rmfDeployBar').style.width = `${Math.round(progress.percent)}%`;
    }
    if (progress && progress.text) $g('rmfDeployPhase').textContent = progress.text;
    if (!progress || !progress.done) return;

    rmfStopDeployPolling();
    $g('rmfDeployProgress').classList.add('hidden');
    rmfShowDeployResult(progress.error ? 'error' : 'success');
  }, 1000);
}
$g('rmfDeployBtn').addEventListener('click', () => rmfStartDeploy());

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
    rmfHandleError(e, $g('rmfRefreshError'), () => rmfStartFirstFetch(item, btn));
  }
}

// Same "fires once each time arriving from a DIFFERENT sub-tab" reset pattern (2026-08-27,
// merge-entry-reset) -- closes any lingering SSE connections (a mid-scan/mid-extract visit
// left open connections that would keep emitting into a screen the user has already left),
// resets rmfState back to its defaults, goes back to Step 0, and reloads collections. Called
// from cleanup-app.js's showUtilitiesSubTab when arriving from a different sub-tab
// (previousSubTab check, same pattern as Cycle Helper's own chStartOver). Unlike most other
// resets which just call existing per-step reset functions, this one handles the
// SSE-connection cleanup that's unique to Rebuild Missing Files.
function rmfResetOnEntry() {
  if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
  if (rmfState.extractEventSource) { rmfState.extractEventSource.close(); rmfState.extractEventSource = null; }
  rmfStopDeployPolling();
  rmfAnyRestoreThisRun = false;
  $g('rmfDeployPending').classList.add('hidden');
  $g('rmfDeployProgress').classList.add('hidden');
  $g('rmfDeployResult').classList.add('hidden');
  rmfState.picked.clear();
  rmfState.collectionsById.clear();
  rmfState.rows = [];
  rmfState.selected.clear();
  rmfResetKindFilterToDefault();
  rmfRenderStepper(0);
  $g('rmfPickerView').classList.remove('hidden');
  $g('rmfReportView').classList.add('hidden');
  rmfLoadCollections();
}
window.rmfResetOnEntry = rmfResetOnEntry;
