'use strict';
// Rebuild Missing Files (Utilities sub-tab) -- checks one or more picked collections for staging
// files that are missing, and lets the user restore just those from the archive. Reuses $g/el from
// cleanup-app.js, same "self-contained area, shared tiny helpers" convention as this project's
// other *-app.js files. See design/vortex-rebuild-missing-files-mockup.html for the approved
// visual/interaction reference this page's markup and behavior were built from.

// Mod names and server error text come from outside (a mod author, a file name): escape before any innerHTML.
function escHtmlRmf(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const rmfState = {
  configured: true,
  picked: new Set(), // collectionModId
  collectionsById: new Map(), // collectionModId -> { name, modCount, group }
  rows: [], // flattened scan report rows -- see rmfRenderReport
  selected: new Set(), // row index
  eventSource: null,
  extractEventSource: null,
  // "Rebuild Missing Files: download missing archives automatically during the scan" (2026-09-14):
  // { enabled, premium } from the scan's own archiveAutoDownload result -- premium is null until the
  // scan actually needed to check (nothing eligible this scan, or the setting's off). Read by
  // rmfShowDownloadArchiveButton() below; premium===false is the ONLY case that hides the button (see
  // its own comment).
  archiveAutoDownload: { enabled: false, premium: null },
};

// The Download Archive button is hidden only when auto-download is ON and this account was just
// confirmed NOT Premium -- Nexus's API can't do the download either way, so the manual button would
// just fail identically to the automatic attempt that already ran. Every other case keeps it: the
// setting's off (never attempted), or Premium but this specific row still failed (a real network/
// Nexus error) or was never eligible (AMBIGUOUS -- needs a human pick) -- all real fallback cases the
// director's own enumeration keeps the button for.
function rmfShowDownloadArchiveButton() {
  return !(rmfState.archiveAutoDownload.enabled && rmfState.archiveAutoDownload.premium === false);
}

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
    // Every RMF vortex-running gate is the Bridge-unreachable-while-running case, never a genuine
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
  // 2026-09-17, director's own repro: a batch too big even after chunking (see
  // rebuild-missing-extract-chunking.js's own rmfSplitOversizedItems, meant to close exactly this
  // gap -- if it's still reachable, something in that split logic itself needs another look, not
  // just this message). rmfApi's own generic fallback has nothing better to show here: a 413 is
  // Express's own body-parser rejecting the request before it ever reaches a route handler, so
  // there's no JSON body/`data.message` to read at all -- e.message would otherwise be the bare
  // "Request failed (413)" the director actually saw.
  if (e.status === 413) {
    box.textContent = "This batch is too large to extract all at once, and no files were extracted. Try selecting fewer mods, or extract the largest one on its own.";
    box.classList.remove('hidden');
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
  // "Back to Collections also starts clean" (2026-09-17, director's own reversal of 8c5d3e6): once
  // the run is actually Done (rmfDoneActions is only ever shown in that state -- see
  // rmfSetBackBtnState's own 'done' branch), this same shared button now does a full reset -- no
  // collections picked, cart bar empty, filters back to default, fresh collection list -- instead of
  // quietly keeping the previous picks checked. Cancel (mid-scan) and Back (reviewing results) below
  // are UNCHANGED: those still preserve the picks so the user can adjust and re-scan, which is a
  // genuinely different action from "I'm done, start over."
  if (!$g('rmfDoneActions').classList.contains('hidden')) { rmfResetOnEntry(); return; }
  if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
  $g('rmfScanLoading').classList.add('hidden');
  $g('rmfReportView').classList.add('hidden');
  $g('rmfPickerView').classList.remove('hidden');
  rmfSetBackBtnState('results');
  // Step 1 (the picker) has no Cancel/Back of its own -- see rmfSetBackBtnState's own comment on why
  // this is a separate toggle from the label/class/placement it already handles.
  $g('rmfBackToPickerBtn').classList.add('hidden');
  rmfRenderStepper(0);
});

// Same button does triple duty -- Cancel while a scan is actively running, plain "Back" while
// reviewing scan results (Step 2), "Back to Collections" once Done (Step 3). Replaces the old
// two-state "Cancel"/"← Check Different Collections" toggle (director's own correction, 2026-09-01:
// "pretty sure we removed that and use back buttons now") with this app's standard nav-button
// convention -- plain ghost "Back" matching frBackBtn/chHistoryCancelBtn/ucv2CancelReviewBtn, and
// "Back to Collections" (btn--primary) matching ucv2ApplyResultBackBtn exactly for the completed-
// result state. The click handler above already does the real work (close the EventSource)
// regardless of which state is currently showing.
//
// "tighter stepper row, standard Done banner" (2026-09-14): this ONE real button element now also
// PHYSICALLY MOVES between two homes, not just relabels -- #rmfStepperRow's own row (scanning/
// results, right-aligned via the scoped `.sync-stepper-row #rmfBackToPickerBtn` CSS override) or
// #rmfDoneActions (done, underneath whichever success banner/Deploy prompt is showing, DESIGN.md's
// own bottom `.actions` row). appendChild on an element already in the DOM relocates it without
// losing its listener -- the single addEventListener above keeps working regardless of which
// container currently holds it. Visibility on step 1 (the picker, no Cancel/Back at all) is a
// SEPARATE concern handled at each of the 3 view-transition points instead of here, since this
// function only ever runs while already on screen 2 -- see rmfResetOnEntry/the click handler above/
// rmfStartScan below.
function rmfSetBackBtnState(state) {
  const btn = $g('rmfBackToPickerBtn');
  const doneActions = $g('rmfDoneActions');
  if (state === 'scanning') {
    btn.textContent = 'Cancel';
    btn.className = 'btn btn--ghost btn--small';
    $g('rmfStepperRow').appendChild(btn);
    doneActions.classList.add('hidden');
  } else if (state === 'done') {
    btn.textContent = 'Back to Collections';
    btn.className = 'btn btn--primary';
    doneActions.appendChild(btn);
    doneActions.classList.remove('hidden');
  } else {
    // 'results' -- "Back sits next to Continue" (2026-09-16, director: "it's lost up there, didn't
    // even see it"). DESIGN.md's own button-row rule 4: with a selection bar, Back goes immediately
    // left of the bar's own primary action on its right side, never alone in the stepper row.
    btn.textContent = 'Back';
    btn.className = 'btn btn--ghost btn--small';
    const selectionBar = $g('rmfSelectionBar');
    if (selectionBar.classList.contains('hidden')) {
      // Defensive fallback, per DESIGN.md's own rule: Scan Results reached with no selection bar
      // showing puts Back in the bottom .actions row instead of stranding it in the stepper row.
      // Shouldn't occur today -- 'results' state and the selection bar's own visibility are both
      // gated on the SAME rmfHasSelectableRows() check -- but never silently regress to the old
      // lost-up-top placement if that invariant ever changes.
      doneActions.appendChild(btn);
      doneActions.classList.remove('hidden');
    } else {
      $g('rmfSelectionBarRight').insertBefore(btn, $g('rmfExtractSelectedBtn'));
      doneActions.classList.add('hidden');
    }
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
// nav button switches to "Back to Collections"; and the real Deploy prompt shows. Reverts every one
// of these the moment `done` is false again (still reviewing).
//
// Deploy now shows on EVERY Done landing (2026-09-14, "the same Deploy step on every Done screen"),
// not just after a real restore -- the director may not have deployed since an earlier rebuild or
// update. `restoredThisRun` (renamed from the old offerDeploy, which used to gate VISIBILITY -- see
// rmfAnyRestoreThisRun's own header comment) now only picks which of the two title/body variants
// shows: a real restore gets "one step left" with the explanatory body; an all-clear scan (nothing
// to restore) gets the plain title-only prompt, since nothing here changed staging this run.
function rmfSetDoneUI(done, restoredThisRun) {
  $g('rmfStatGrid').classList.toggle('hidden', done);
  $g('rmfSummaryBadges').classList.toggle('hidden', done);
  rmfSetBackBtnState(done ? 'done' : 'results');
  $g('rmfDeployPending').classList.toggle('hidden', !done);
  if (done) {
    const title = $g('rmfDeployPendingTitle');
    const body = $g('rmfDeployPendingBody');
    if (restoredThisRun) {
      title.textContent = '🚀 One step left';
      body.textContent = "Your files are restored in staging, but your game can't see them yet. Deploy your mods to finish.";
      body.classList.remove('hidden');
    } else {
      title.textContent = '🚀 Deploy your mods';
      body.classList.add('hidden');
    }
  } else {
    $g('rmfDeployProgress').classList.add('hidden');
    $g('rmfDeployResult').classList.add('hidden');
  }
}

// ---------- Scan (Screen 2) ----------

async function rmfStartScan() {
  // Safety net only -- rmfScanBtn is disabled whenever rmfState.picked is empty (rmfUpdatePickCount),
  // but stay on step 1 rather than switching to a "Scanning..." screen with nothing to scan if this
  // is ever reached with zero picks anyway (e.g. the disabled-state getting out of sync again).
  if (rmfState.picked.size === 0) return;
  $g('rmfPickerView').classList.add('hidden');
  $g('rmfReportView').classList.remove('hidden');
  $g('rmfResults').classList.add('hidden');
  // rmfActionsHelp is a SIBLING of rmfResults, not a child (real bug found live 2026-08-25) --
  // hiding rmfResults alone left this showing throughout the whole scan, above an otherwise-empty
  // screen with nothing yet to select or extract.
  $g('rmfActionsHelp').classList.add('hidden');
  $g('rmfScanError').classList.add('hidden');
  $g('rmfRefreshFailuresCallout').classList.add('hidden');
  $g('rmfNotPremiumCallout').classList.add('hidden');
  $g('rmfScanLoading').classList.remove('hidden');
  $g('rmfScanLoadingText').textContent = 'Starting scan…';
  rmfSetBackBtnState('scanning');
  $g('rmfBackToPickerBtn').classList.remove('hidden'); // hidden on step 1 (the picker) -- see rmfResetOnEntry
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
  } else if (frame.type === 'checking-premium') {
    // "Rebuild Missing Files: download missing archives automatically during the scan" (2026-09-14)
    // -- same wording app.js's own PHASE_TEXT uses for Rebuild Collection's identical check.
    $g('rmfScanLoadingText').textContent = 'Checking Nexus Premium status…';
  } else if (frame.type === 'downloading-missing-archive') {
    // Same wording/truncation as app.js's own 'download-progress' phase text for Rebuild Collection
    // (truncatePhaseName is a plain global function declared in app.js, loaded before this file).
    $g('rmfScanLoadingText').textContent = `Downloading missing archive (${frame.index}/${frame.total}): ${truncatePhaseName(frame.name)}…`;
  } else if (frame.type === 'scan-complete') {
    $g('rmfScanLoading').classList.add('hidden');
    // No rmfSetBackBtnState call here -- rmfRenderReport below always calls rmfSetDoneUI itself,
    // which sets the real final back-button state (done vs. still reviewing) based on the actual
    // results, superseding any intermediate value this line could set.
    if (rmfState.eventSource) { rmfState.eventSource.close(); rmfState.eventSource = null; }
    rmfState.archiveAutoDownload = frame.archiveAutoDownload || { enabled: false, premium: null };
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
  // "Rebuild Missing Files: download missing archives automatically during the scan" (2026-09-14) --
  // the persistent not-Premium notice, same "shows once, stays up" treatment as the refresh-failures
  // callout just above and Rebuild Collection's own downloadNotice. Only ever true when the setting is
  // ON and this scan actually had something eligible to auto-download AND confirmed the account isn't
  // Premium -- see rmfShowDownloadArchiveButton's own header for why this is the one case (not "setting
  // off", not "Premium but this row still failed") that changes each row's own action button too.
  if (rmfState.archiveAutoDownload.premium === false) {
    $g('rmfNotPremiumCallout').textContent = "Nexus API only allows automated downloads for Premium accounts -- this respects Nexus's ad-supported download model for free users. Download the archive(s) below manually from Nexus, or upgrade to Premium.";
  }
  $g('rmfNotPremiumCallout').classList.toggle('hidden', rmfState.archiveAutoDownload.premium !== false);
  for (const c of collectionResults) {
    if (c.error) continue;
    for (const mod of c.modsWithMissing || []) {
      rmfState.rows.push({ kind: 'missing', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
    }
    for (const mod of c.modsArchiveMissing || []) {
      // collectionDomainName: the collection-wide default game domain (missing-files-scan.js's own
      // scanCollections), used to build a real Nexus "view files" link when this account isn't
      // Premium -- a mod's OWN domainName (set only when cross-listed under a different game) takes
      // priority when present, same fallback order resolveAndDownloadArchive's own gameDomain uses.
      rmfState.rows.push({ kind: 'archive-missing', collectionModId: c.collectionModId, collectionName: c.name, collectionDomainName: c.domainName, ...mod });
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
    // "mods it couldn't check show up instead of hiding" (2026-09-14) -- server-side
    // scanCollections' own new modsUnchecked bucket, surfaced here instead of silently dropped the
    // way every 'skipped' scanOneMod result used to be. Genuinely needs attention (this tool never
    // confirmed the mod is actually complete), so it's counted the same way missing/archive-missing
    // rows are everywhere below -- see rmfHasRowsNeedingAttention().
    for (const mod of c.modsUnchecked || []) {
      rmfState.rows.push({ kind: 'unchecked', collectionModId: c.collectionModId, collectionName: c.name, ...mod });
    }
  }

  $g('rmfResults').classList.remove('hidden');
  $g('rmfStatColls').textContent = stats.collectionsChecked;
  $g('rmfStatMods').textContent = stats.modsWithMissing;
  $g('rmfStatFiles').textContent = stats.filesMissing;
  $g('rmfOptionalSkippedNote').classList.toggle('hidden', !(stats.optionalSkipped > 0));

  // Real gap fixed 2026-08-25: the table/selection controls/action-help used to hide only when
  // rmfState.rows was LITERALLY empty -- but rows also includes the 'excepted' kind, which is
  // informational-only (its own checkbox is disabled, nothing to select or extract). A
  // collection with nothing actionable left except those still showed the whole active-work UI
  // (Select All, Extract Selected, the table) for nothing to act on. hasSelectable is the real
  // condition for "is there still work to do here" -- trulyEmpty is reserved for the plain
  // "literally nothing at all" case (rmfAllClearCallout).
  //
  // REVISED 2026-09-16 ("a Couldn't Check row doesn't strand the finished screen"): the 2026-09-14
  // fix broadened this SAME check to rmfHasRowsNeedingAttention() so an 'unchecked' row would keep
  // suppressing the all-clear banner -- but that also meant a scan left with ONLY an 'unchecked' row
  // (nothing selectable at all) never reached Done: no Deploy panel, a stranded "0 of 0 selected"
  // selection bar with nothing to select, and the stale pre-shared-Deploy-step wording below. Split
  // back into two separate concepts (rmfHasSelectableRows/rmfHasRowsNeedingAttention, see their own
  // header comments) -- this done-transition/visibility check uses ONLY the narrower "selectable"
  // one; the all-clear-suppression check below still uses the broader one.
  const { hasSelectable, hasAttention, trulyEmpty } = rmfRefreshResultsVisibility();
  // filesMissing/modsWithMissing only ever count 'missing' rows -- an 'archive-missing' row (its
  // files can't even be checked yet without the archive) never adds to either. So hasSelectable-but-
  // filesMissing-0 is a real case (archive issues only) and the "0 files are missing across 0 mods"
  // wording was flatly wrong there -- confirmed live 2026-08-25. The per-row "⚠️ {reason}" note and
  // the "N Archive Issue(s)" filter badge above already cover that case, so just skip the summary
  // callout entirely rather than inventing a second banner that duplicates them.
  const showSummary = stats.filesMissing > 0;
  $g('rmfExtractResultsCallout').classList.add('hidden');
  const summary = $g('rmfSummaryCallout');
  if (trulyEmpty || (hasSelectable && !showSummary) || (!hasSelectable && hasAttention)) {
    // The last branch is the real fix here: nothing selectable, but a Couldn't Check row remains --
    // never claim "No Missing Files Detected" (or anything else implying total completeness). The
    // new rmfCouldntCheckCallout (rendered inside rmfRefreshResultsVisibility above) carries that
    // message instead; this banner just stays out of its way.
    summary.classList.add('hidden');
  } else if (!hasSelectable) {
    // "External Changes" static note removed from here (2026-09-01) -- this branch fires on a
    // FRESH scan that found nothing missing (and nothing left unchecked either), so this tool never
    // wrote anything this run; there was never a real trigger for Vortex's own dialog to begin with
    // (pre-existing bug: the note used to show here unconditionally even though nothing was restored
    // -- director's own catch).
    summary.classList.remove('hidden');
    summary.className = 'callout callout--success';
    // Points at this tool's own Deploy button below (#rmfDeployPending, now shown on every Done
    // landing -- 2026-09-14, "the same Deploy step on every Done screen") instead of sending the
    // director to Vortex directly, consistent with the after-restore "Restoration Complete!"
    // wording just below in rmfApplyExtractResults.
    summary.innerHTML = '<div class="callout__title">🎉 No Missing Files Detected</div>'
      + '<p>All mods are complete. No repairs are needed in your staging folder. Click <strong>Deploy</strong> below if you haven\'t deployed since your last change.</p>';
  } else {
    summary.classList.remove('hidden');
    summary.className = 'callout callout--warning';
    summary.innerHTML =
      `<b>${stats.filesMissing} file${stats.filesMissing === 1 ? '' : 's'}</b> ${stats.filesMissing === 1 ? 'is' : 'are'} missing across ` +
      `<b>${stats.modsWithMissing} mod${stats.modsWithMissing === 1 ? '' : 's'}</b>. Fixing these only updates your staging folder — ` +
      `open Vortex and click <strong>Deploy Mods</strong> afterward.`;
  }
  $g('rmfAllClearCallout').classList.toggle('hidden', !trulyEmpty);
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
  // "mods it couldn't check show up instead of hiding" (2026-09-14) -- server-side scanOneMod's own
  // 'skipped' bucket (an unresolvable install: an ambiguous archive that even the fixed findModRoot
  // couldn't settle, an Open FOMOD with no recorded choices, or an unhandled FOMOD feature). Warning
  // color, not critical -- this isn't confirmed-broken the way a 'missing' row is, but it genuinely
  // needs attention (rmfHasRowsNeedingAttention treats it the same as missing/archive-missing) since
  // the tool never actually confirmed the mod is complete.
  unchecked: { label: "Couldn't Check", badgeClass: 'badge--warning' },
};

// "mods it couldn't check show up instead of hiding" (2026-09-14) -- the single shared definition of
// "is there still something here the user needs to deal with." Previously this exact condition
// (missing || archive-missing) was independently duplicated in FOUR places across this file
// (rmfRenderReport, twice in rmfApplyExtractResults, and rmfDownloadArchive) -- a real risk that a
// future change (like this one, adding 'unchecked') updates some call sites and misses others, which
// would let the "No Missing Files Detected" all-clear fire while an unchecked mod still sits there.
// One function, called everywhere the old inline expression was.
function rmfHasRowsNeedingAttention() {
  return rmfState.rows.some((r) => r.kind === 'missing' || r.kind === 'archive-missing' || r.kind === 'unchecked');
}

// "a Couldn't Check row doesn't strand the finished screen" (2026-09-16) -- a SEPARATE, narrower
// concept from rmfHasRowsNeedingAttention() above: "is there still something this screen can
// actually DO" (missing/archive-issue rows -- rmfIsSelectable's own pair, same rows Extract/Download
// Archive can act on) vs. "is there still something worth telling the user about at all" (that PLUS
// 'unchecked'). Conflating the two was a real bug the design side's own sandbox review caught: a
// scan left with only a Couldn't Check row (nothing left to select) never reached the Done screen at
// all, because the done-transition check was ALSO using the broader needs-attention definition.
// rmfHasSelectableRows() governs the done transition/selection bar/table/actions-help visibility;
// rmfHasRowsNeedingAttention() is reserved for ONLY suppressing the all-clear/"No Missing Files
// Detected" wording, which must stay suppressed even once nothing is selectable.
function rmfHasSelectableRows() {
  return rmfState.rows.some(rmfIsSelectable);
}

// One shared place deciding "reviewing vs. Done" visibility from the CURRENT rmfState.rows --
// called after every action that can change which rows are left (a fresh scan, an extraction
// finishing OR erroring out, Add to Exception List). Replaces what used to be four independently
// duplicated toggle blocks (rmfRenderReport, twice in rmfApplyExtractResults, rmfDownloadArchive) --
// exactly the kind of drift risk that produced the done-transition bug this task fixes, so this
// consolidates it into one function instead of trusting every call site to stay in sync by hand.
// Returns the three flags callers need for their OWN remaining bespoke content (summary banner
// wording, extract-results wording) so they don't have to recompute them.
function rmfRefreshResultsVisibility() {
  const hasSelectable = rmfHasSelectableRows();
  const hasAttention = rmfHasRowsNeedingAttention();
  const trulyEmpty = rmfState.rows.length === 0;
  rmfRenderStepper(hasSelectable ? 1 : 2);
  // Selection bar's own visibility MUST be settled before rmfSetDoneUI (which relocates
  // rmfBackToPickerBtn into it via rmfSetBackBtnState('results')) -- that function checks whether
  // the selection bar is CURRENTLY hidden to decide where Back belongs, so it needs this render's
  // real answer, not whatever was left over from the previous one.
  $g('rmfSelectionBar').classList.toggle('hidden', !hasSelectable);
  $g('rmfTableWrap').classList.toggle('hidden', !hasSelectable);
  $g('rmfActionsHelp').classList.toggle('hidden', !hasSelectable);
  rmfSetDoneUI(!hasSelectable, rmfAnyRestoreThisRun);
  rmfRenderCouldntCheckAttention(!hasSelectable);
  return { hasSelectable, hasAttention, trulyEmpty };
}

// "Add to Exception List" (queue: rebuild-missing-hand-pick-exceptions) -- offered on every
// 'missing'/'archive-missing'/'unchecked' row (real case this exists for: a hand-pick-only FOMOD,
// e.g. "1DustAdeptArmorSE", where auto-extracting/auto-rebuilding the full archive would install
// content the user never chose; for an 'unchecked' row specifically, see its own build-actions-cell
// comment on why this genuinely stops the mod from hitting the resolver again). A ghost btn, not
// primary -- this is an opt-out action, not the row's main "fix it" action (Extract from Archive/
// Download Archive keep that spot on a selectable row; an 'unchecked' row has no fix action at all).
function rmfBuildExceptionBtn(row) {
  const btn = el('button', { class: 'btn btn--ghost btn--small' }, 'Add to Exception List');
  btn.addEventListener('click', () => rmfAddException(row, btn));
  return btn;
}

// Needs-attention callout for 'unchecked' rows, shown ONLY on the Done screen (nothing left
// selectable) -- DESIGN.md's own ".rbc-attn-*" pattern (see its "Needs-attention callout" section),
// same shape Rebuild Collection's own Done-screen attention rows already use. While STILL reviewing
// (something selectable remains), an 'unchecked' row keeps showing in the normal filterable table
// instead -- this callout is reserved for the moment that table itself hides, so a Couldn't Check
// row is never simply invisible.
function rmfBuildCouldntCheckAttnRow(row, idx) {
  const actions = [];
  // Same skipKind gate the main table's own rmfBuildActionsCell uses -- an unhandled-feature/
  // resolve-error row has no real picker to offer, only a real Open FOMOD does.
  if (row.skipKind === 'open-fomod') {
    const installBtn = el('button', { class: 'btn btn--small btn--primary' }, 'Install');
    installBtn.addEventListener('click', () => rmfInstallFomod(row, idx, installBtn));
    actions.push(installBtn);
  }
  actions.push(rmfBuildExceptionBtn(row));
  const row2 = el('div', { class: 'rbc-attn-row' }, [
    el('div', { class: 'rbc-attn-row__main' }, [
      el('div', { class: 'rbc-attn-row__name' }, row.name),
      el('div', { class: 'rbc-attn-row__why' }, row.reason || 'This mod could not be checked for missing files.'),
    ]),
    el('div', { class: 'rbc-attn-row__actions' }, actions),
  ]);
  return row2;
}
function rmfRenderCouldntCheckAttention(show) {
  const callout = $g('rmfCouldntCheckCallout');
  const uncheckedRows = rmfState.rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.kind === 'unchecked');
  if (!show || uncheckedRows.length === 0) {
    callout.classList.add('hidden');
    return;
  }
  callout.classList.remove('hidden');
  const n = uncheckedRows.length;
  const anyInstallable = uncheckedRows.some(({ row }) => row.skipKind === 'open-fomod');
  $g('rmfCouldntCheckTitle').textContent = n === 1 ? "⚠️ One mod couldn't be checked" : `⚠️ ${n} mods couldn't be checked`;
  // Body now matches the real count (singular vs. plural) instead of a static "these mods" line
  // that misread as several even for one, and points at Install (once it exists for at least one
  // row here) rather than only ever naming the exceptions list as the sole option.
  $g('rmfCouldntCheckBody').textContent = n === 1
    ? (anyInstallable
      ? `This mod has a FOMOD wizard or another issue the tool couldn't resolve automatically. No files were extracted — click Install to pick your options, or add it to the exceptions list if that's expected.`
      : `This mod has a FOMOD wizard or another issue the tool couldn't resolve automatically. No files were extracted — check the mod, or add it to the exceptions list if that's expected.`)
    : (anyInstallable
      ? `These mods have a FOMOD wizard or another issue the tool couldn't resolve automatically. No files were extracted — click Install where available, or add them to the exceptions list if that's expected.`
      : `These mods have a FOMOD wizard or another issue the tool couldn't resolve automatically. No files were extracted — check the mods, or add them to the exceptions list if that's expected.`);
  const list = $g('rmfCouldntCheckList');
  list.innerHTML = '';
  for (const { row, idx } of uncheckedRows) list.appendChild(rmfBuildCouldntCheckAttnRow(row, idx));
}

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
  for (const key of ['missing', 'archive-missing', 'unchecked', 'excepted']) {
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
    // extracts, same chain the per-row Download Archive button already runs on its own. ONLY when it
    // has a real Nexus modId, though (2026-09-17, "stop bulk-selecting mods that can never auto-
    // extract") -- a non-Nexus archive-missing row (row.modId == null) has no archive this tool can
    // fetch on its own; batching it in used to send {modId:null, fileId:null} to /extract, which
    // reached resolveAndDownloadArchive's own required-fields check and surfaced the raw
    // "collectionModId, modId, and fileId are required." text in the results banner. Matches
    // Rebuild Collection's own equivalent gate (web/rebuild-routes.js's canRetryDownload).
    checkbox.disabled = row.kind !== 'missing' && !(row.kind === 'archive-missing' && row.modId != null);
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

    tr.appendChild(el('td', {}, rmfBuildVersionCell(row)));

    tr.appendChild(el('td', { class: 'coll-tag muted' }, row.collectionName));

    tr.appendChild(el('td', {}, rmfBuildMissingCell(row, idx)));

    tr.appendChild(el('td', {}, rmfBuildActionsCell(row, idx)));

    tbody.appendChild(tr);
  });
  rmfRefreshSelectionUI();
}

// Version column (2026-09-22, "flag when the installed version is newer than the collection's
// pinned version") -- installedVersionNewer is precomputed server-side (lib/missing-files-scan.js's
// own scanOneMod), so this only ever renders a flag, never decides one. Reuses Duplicate Version
// Cleanup's own existing status-pill--version/--version-flagged pattern (styles.css, DESIGN.md
// ~line 686) rather than inventing new CSS -- same amber Warning-severity treatment, ⚠ prefix, and
// title tooltip, just applied to a single-value cell instead of a list of sub-item pills. The
// unflagged case is left exactly as it looked before this change (plain muted text, no pill) --
// this only ever adds a pill, never changes the normal row's appearance.
//
function rmfBuildVersionCell(row) {
  if (!row.installedVersionNewer) {
    return el('span', { class: 'muted' }, row.version || '—');
  }
  const tooltip = `You have a newer version installed (v${row.installedVersion}) than this collection uses (v${row.version}). Extracting or downloading will replace it with the older version.`;
  return el('span', { class: 'status-pill status-pill--version-flagged', title: tooltip }, `⚠ v${row.version}`);
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
  if (row.kind === 'unchecked') {
    return el('div', { class: 'detail-cell' }, [
      el('span', { class: 'status-pill status-pill--warning' }, "Couldn't check"),
      el('div', { class: 'muted', style: 'margin-top:4px' }, row.reason || 'This mod could not be checked for missing files.'),
    ]);
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
  } else if (row.kind === 'unchecked') {
    // "Open FOMOD mods get an Install button" (2026-09-17) -- a real Open FOMOD (skipKind ===
    // 'open-fomod') gets the SAME shared picker Update Collection already uses, primary action,
    // since this tool can genuinely fix it now rather than only naming the limitation. The OTHER two
    // 'skipped' reasons (an unhandled FOMOD feature, a genuine resolve error) have no real picker to
    // offer -- no Extract/Download/Install button for those, same as before this task.
    if (row.skipKind === 'open-fomod') {
      const installBtn = el('button', { class: 'btn btn--small btn--primary' }, 'Install');
      installBtn.addEventListener('click', () => rmfInstallFomod(row, idx, installBtn));
      actions.appendChild(installBtn);
    }
    // "Add to Exception List" is still offered regardless: scanOneMod's own Mod Exceptions check
    // runs BEFORE install resolution (it's what produces the 'excepted' bucket), so adding an
    // unresolvable mod here genuinely stops it from hitting the resolver -- and the "Couldn't Check"
    // row -- again.
    actions.appendChild(rmfBuildExceptionBtn(row));
  } else if (row.modId != null && !rmfShowDownloadArchiveButton()) {
    // Not Premium, and the setting is on -- the automated attempt already ran and failed the same
    // way a manual click would, so the button here would just be a guaranteed-to-fail dead end
    // (2026-09-14, director's own case: "the only time Download Archive should show up is if there's
    // a network issue"). A real link to the mod's own Nexus files page instead.
    const domain = row.domainName || row.collectionDomainName;
    if (domain) {
      const link = el('a', { class: 'btn btn--ghost btn--small', href: `https://www.nexusmods.com/${domain}/mods/${row.modId}?tab=files`, target: '_blank', rel: 'noopener' }, 'View files on Nexus');
      actions.appendChild(link);
    } else {
      actions.appendChild(el('span', { class: 'muted', style: 'font-size:12px' }, 'Download this archive manually from Nexus.'));
    }
    actions.appendChild(rmfBuildExceptionBtn(row));
  } else if (row.modId != null) {
    const dlBtn = el('button', { class: 'btn btn--small' }, 'Download Archive');
    dlBtn.addEventListener('click', () => rmfDownloadArchive(row, idx, dlBtn));
    actions.appendChild(dlBtn);
    actions.appendChild(rmfBuildExceptionBtn(row));
  } else {
    // Non-Nexus archive-missing row (2026-09-17, "let a non-Nexus mod's archive be imported") --
    // ports Rebuild Collection's own already-shipped off-site Import flow (lib/offsite-import-map.js,
    // classifyMod's overrideArchivePath) instead of leaving this a dead end. Label per the director's
    // own framing: find the file, import it, extraction proceeds from there.
    const browseBtn = el('button', { class: 'btn btn--small' }, 'Browse…');
    browseBtn.addEventListener('click', () => rmfImportOffsite(row, idx, browseBtn));
    actions.appendChild(browseBtn);
    actions.appendChild(rmfBuildExceptionBtn(row));
  }
  return actions;
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
      // An 'unchecked' row exempted from the Done screen's own attention callout (see
      // rmfBuildCouldntCheckAttnRow) needs that callout rebuilt too -- it's a SEPARATE render from
      // rmfRenderRows() above (the normal table), and the row just disappears from the list once it's
      // no longer 'unchecked', rather than a static "✓ Added" placeholder.
      rmfRefreshResultsVisibility();
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

// row.kind === 'missing' || ('archive-missing' with a real Nexus modId) -- the selectable kinds
// (2026-09-02 v5 addendum; narrowed 2026-09-17, see the checkbox's own disabled-check comment above
// for why a non-Nexus archive-missing row is excluded). A small helper since this same check now
// recurs across every selection action below.
function rmfIsSelectable(row) { return row.kind === 'missing' || (row.kind === 'archive-missing' && row.modId != null); }

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
// "the old results table is still on screen" (2026-09-16, director's real screenshot: Extract
// running, the progress list showing correctly, but the ORIGINAL results table still sitting right
// underneath it -- every row still checked, its own Extract from Archive button just greyed out).
// UX principle 14 ("once something is no longer valid, don't show it"): once Extract starts, the
// progress list REPLACES the results table, it doesn't sit on top of it -- same real screen-handoff
// Update Collection's own Apply step already does (ucv2ConfirmApply navigates to a whole separate
// ucv2ScreenApplyProgress, no review table visible underneath at all, and -- confirmed by reading
// that screen's own markup -- no Back/Cancel control shown there either while a write is running).
function rmfSetExtractingUI(active) {
  $g('rmfExtractLoading').classList.toggle('hidden', !active);
  document.querySelectorAll('.rmf-extract-trigger').forEach((btn) => { btn.disabled = active; });
  if (active) {
    $g('rmfStatGrid').classList.add('hidden');
    $g('rmfSummaryBadges').classList.add('hidden');
    $g('rmfSummaryCallout').classList.add('hidden');
    $g('rmfAllClearCallout').classList.add('hidden');
    $g('rmfCouldntCheckCallout').classList.add('hidden');
    $g('rmfSelectionBar').classList.add('hidden');
    $g('rmfTableWrap').classList.add('hidden');
    $g('rmfActionsHelp').classList.add('hidden');
  } else {
    // rmfExtractSelectedBtn's real disabled state depends on selection count, not just "not
    // extracting" -- rmfRefreshSelectionUI is the single source of truth for that, so let it settle
    // the bulk button back to correct rather than force it enabled here.
    rmfRefreshSelectionUI();
    // Restores whatever was showing before extraction started. On a successful extraction this runs
    // a moment before rmfApplyExtractResults' OWN call to the same function (using rows it hasn't
    // updated yet) -- both calls are synchronous, so nothing paints in between; the visible result is
    // always the final, post-mutation one. On an ERROR path (rmfDoExtract's catch, or an
    // 'extract-error' SSE frame) this is the ONLY restore that runs at all, since neither of those
    // falls through to rmfApplyExtractResults -- without it, an extraction that fails outright would
    // leave the whole reviewing UI hidden with no way back except a fresh scan.
    rmfRefreshResultsVisibility();
    // Real bug (2026-09-16, director's own screenshot): on that same error path, the per-mod
    // progress table built by rmfBuildExtractProgressTable -- still showing every row as "Waiting",
    // since the request never even got a chance to update any of them -- stayed on screen ABOVE the
    // just-restored missing-files table. rmfApplyExtractResults already hides both of these on the
    // SUCCESS path (its own comment: "hidden right here, at the exact point that flow takes over");
    // this is the matching hide for every path that does NOT reach that function, done once here
    // rather than at each error call site so no future caller can reintroduce the same gap.
    $g('rmfExtractProgressBarWrap').classList.add('hidden');
    $g('rmfExtractTableWrap').classList.add('hidden');
  }
}

// "Rebuild Missing Files: real per-mod status pills during Extract" (2026-09-14) -- one <tr> per
// item in THIS batch, same order as the `indices` array passed to rmfDoExtract, so a server frame's
// 1-based `index` maps straight to `rmfExtractRowEls[index - 1]` with no separate name/id lookup
// (a mod name isn't guaranteed unique across collections, unlike Rebuild Collection's own
// state.progressRows, which keys by name because a single run is always one collection).
let rmfExtractRowEls = [];
let rmfExtractProgressTotal = 0;
let rmfExtractProgressDone = 0;

// A single mod's own missing-file list can be split across several requests
// (rmfSplitOversizedItems, rebuild-missing-extract-chunking.js) -- these track, per ROW (0-based
// position in `indices`, same indexing as rmfExtractRowEls), how many of that row's own sub-items
// haven't reported back yet and what their live results add up to SO FAR, so the row only shows a
// final Restored/Failed pill -- and only counts toward "X of Y mods done" -- once every one of its
// own sub-items has resolved, not after the first. All three reset at the start of every
// rmfDoExtract run (rmfRowUnitCounts[i] is always 1 for a row that was never split).
let rmfRowUnitCounts = [];
let rmfRowSubItemsRemaining = [];
let rmfRowLiveAccum = [];

function rmfBuildExtractProgressTable(indices) {
  const tbody = $g('rmfExtractTableBody');
  tbody.innerHTML = '';
  rmfExtractRowEls = indices.map((i) => {
    const row = rmfState.rows[i];
    const tr = el('tr', {});
    tr.appendChild(el('td', {}, row.name));
    const statusCell = el('td', {});
    // ucv2ApplyPillHtml (update-collection-v2-apply-pills.js) is the ONE shared status-pill
    // vocabulary this whole app renders through for a live apply/extract progress row -- reused
    // here rather than app.js's own statusPill (a DIFFERENT lookup, keyed by real run-status
    // strings like REBUILT/FAILED_MISMATCH_NOT_TOUCHED, not by a stage-of-progress key) precisely
    // so this table looks like every other tool's, per the director's own catch: "use the same pill
    // format the other tools use, so they all look the same." Every label passed through here is a
    // fixed literal from this file's own lookup, never row/user data, so no escaping is needed.
    statusCell.innerHTML = ucv2ApplyPillHtml('pending', 'Waiting');
    tr.appendChild(statusCell);
    tr.appendChild(el('td', { class: 'detail-cell' }, ''));
    tbody.appendChild(tr);
    return tr;
  });
  rmfExtractProgressTotal = indices.length;
  rmfExtractProgressDone = 0;
  $g('rmfExtractProgressBar').style.width = '0%';
  $g('rmfExtractProgressBarWrap').classList.remove('hidden');
  $g('rmfExtractTableWrap').classList.remove('hidden');
}

// Same bounded-wrap scroll math as app.js's own updateProgressRow / update-collection-v2-app.js's
// own ucv2UpdateApplyProgressRow -- row.scrollIntoView() walks every scrollable ancestor including
// the window itself, which is what caused the whole page to bounce in both of those precedents;
// this only ever scrolls this table's own bounded wrap.
function rmfUpdateExtractRow(index1Based, key, label, detail) {
  const tr = rmfExtractRowEls[index1Based - 1];
  if (!tr) return;
  tr.children[1].innerHTML = ucv2ApplyPillHtml(key, label);
  tr.children[2].textContent = detail || '';
  const wrap = $g('rmfExtractTableWrap');
  if (wrap) {
    const rowRect = tr.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const offsetWithinWrap = (rowRect.top - wrapRect.top) + wrap.scrollTop;
    const target = offsetWithinWrap - (wrap.clientHeight / 2) + (tr.clientHeight / 2);
    wrap.scrollTo({ top: target, behavior: 'smooth' });
  }
}

// rmfChunkExtractItems / rmfSplitOversizedItems / RMF_EXTRACT_MAX_CHUNK_BYTES:
// rebuild-missing-extract-chunking.js (loaded just before this file -- see index.html) -- own file,
// not defined here, so scripts/test-rmf-extract-chunking.js can require the real chunking logic
// headlessly instead of re-implementing it in the test (this file itself can't be require()'d: it
// runs DOM-touching code at load time, same reason update-collection-v2-apply-pills.js already
// lives in its own file).

// Named (not just an inline listener body) so a Vortex-running retry -- from either a batch's own
// POST failing or its SSE stream reporting extract-error -- can re-run the exact same extraction for
// the same `indices`, rather than leaving Try Again a no-op (queue: rebuild-missing-vortex-retry-
// noop). A full re-run is safe even after a partial success (some earlier chunk(s) already
// extracted for real): extractOneMod re-verifies which files are STILL actually missing right
// before touching anything (existsPlainOrGhosted), so a mod chunking already fixed just comes back
// "Already fixed -- nothing was actually missing anymore" instead of being double-extracted.
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
  // Built ONCE for the full `indices` list, before chunking -- every batch below just fills in
  // further rows of this same table/bar, so a multi-batch run still reads as one continuous
  // extraction, not several separate ones.
  rmfBuildExtractProgressTable(indices);
  $g('rmfExtractLoadingText').textContent = `0 of ${indices.length} mods done`;

  // "Extract can still 413 on a single oversized mod" (2026-09-17) -- a single item's own `files`
  // list can already exceed the server's cap before rmfChunkExtractItems ever gets a chance to
  // split BETWEEN items. rmfSplitOversizedItems runs first and expands any such item into several
  // smaller ones, returning a same-length `itemRowIndices` naming which ORIGINAL row (0-based
  // position in `indices`, matching rmfExtractRowEls) each resulting item came from -- ordinary,
  // unsplit rows just get one entry each, same as before.
  const { items: splitItems, rowIndices: itemRowIndices } = rmfSplitOversizedItems(items);
  const batches = rmfChunkExtractItems(splitItems);

  // Per-row bookkeeping for the (rare) case a row was actually split -- see these globals' own
  // header comment above rmfExtractRowEls.
  rmfRowUnitCounts = indices.map(() => 0);
  itemRowIndices.forEach((rowIndex) => { rmfRowUnitCounts[rowIndex] += 1; });
  rmfRowSubItemsRemaining = rmfRowUnitCounts.slice();
  rmfRowLiveAccum = indices.map(() => ({ extractedCount: 0, ok: true, error: undefined, note: undefined }));
  // One results array per ROW (not per item/sub-item) -- a split row's several partial results
  // land here as they come back, batch by batch, and get merged into one final outcome below.
  const rowResultsBySubItem = indices.map(() => []);

  let cursor = 0;
  for (const batch of batches) {
    // rmfChunkExtractItems preserves order and never drops/reorders items, so slicing
    // itemRowIndices by the same lengths keeps it aligned with this exact batch.
    const batchRowIndices = itemRowIndices.slice(cursor, cursor + batch.length);
    cursor += batch.length;
    let batchResults;
    try {
      batchResults = await rmfRunExtractBatch(batch, batchRowIndices);
    } catch (e) {
      rmfSetExtractingUI(false);
      rmfHandleError(e, $g('rmfScanError'), () => rmfDoExtract(indices));
      return;
    }
    batchResults.forEach((result, k) => { rowResultsBySubItem[batchRowIndices[k]].push(result); });
  }
  rmfSetExtractingUI(false);
  const results = rowResultsBySubItem.map(rmfMergeSubItemResults);
  rmfApplyExtractResults(indices, results);
}

$g('rmfExtractConfirmOkBtn').addEventListener('click', () => {
  $g('rmfExtractConfirmModal').classList.add('hidden');
  rmfDoExtract(rmfPendingExtractIndices);
});

// Runs ONE /extract POST + its own SSE stream to completion and resolves with that batch's own
// `results` array (one entry per item in `batchItems`, same order). `batchRowIndices[k]` names
// which progress-table ROW `batchItems[k]` (and therefore `results[k]`) belongs to -- a direct
// per-position lookup rather than the old single `offset` arithmetic, since a batch can now mix
// ordinary one-item rows with several sub-items of the SAME split row in any order.
function rmfRunExtractBatch(batchItems, batchRowIndices) {
  return rmfApi('POST', '/api/rebuild-missing/extract', { items: batchItems }).then(() => new Promise((resolve, reject) => {
    if (rmfState.extractEventSource) rmfState.extractEventSource.close();
    const es = new EventSource('/api/rebuild-missing/extract/events');
    rmfState.extractEventSource = es;
    es.onmessage = (msg) => {
      const frame = JSON.parse(msg.data);
      if (frame.type === 'extract-complete') {
        es.close();
        rmfState.extractEventSource = null;
        resolve(frame.results);
      } else if (frame.type === 'extract-error') {
        es.close();
        rmfState.extractEventSource = null;
        reject(new Error(frame.message || 'The extraction failed.'));
      } else {
        rmfHandleExtractProgressFrame(frame, batchRowIndices);
      }
    };
  }));
}

function rmfHandleExtractProgressFrame(frame, batchRowIndices) {
  const rowIndex = batchRowIndices[frame.index - 1];
  if (rowIndex === undefined) return;
  if (frame.type === 'mod-started') {
    rmfUpdateExtractRow(rowIndex + 1, frame.phase === 'downloading' ? 'downloading' : 'extracting',
      frame.phase === 'downloading' ? 'Downloading…' : 'Extracting…');
  } else if (frame.type === 'mod-phase') {
    // Only ever fires for an archive-missing row moving from its own download to its own extraction
    // (see downloadThenExtract's onPhase in rebuild-missing-routes.js) -- 'extracting' is the only
    // phase it's ever called with today.
    rmfUpdateExtractRow(rowIndex + 1, 'extracting', 'Extracting…');
  } else if (frame.type === 'mod-extracted') {
    // A live 'mod-extracted' frame only ever carries a COUNT (`frame.extracted`), never the real
    // destination arrays -- those only exist in extract-complete's own `results` (see
    // rmfDoExtract's own rowResultsBySubItem/rmfMergeSubItemResults, which is what
    // rmfApplyExtractResults actually reads). This accumulator is a live-only APPROXIMATION for
    // the progress table's own pill, safe because that table is fully replaced by the real report
    // the moment rmfApplyExtractResults runs -- it never has to be the source of truth.
    const accum = rmfRowLiveAccum[rowIndex];
    accum.extractedCount += frame.extracted || 0;
    if (!frame.ok) { accum.ok = false; accum.error = frame.error || accum.error; }
    if (frame.note) accum.note = frame.note;
    rmfRowSubItemsRemaining[rowIndex] -= 1;
    if (rmfRowSubItemsRemaining[rowIndex] > 0) {
      // More sub-items for this SAME row still coming (a single oversized mod split across several
      // requests) -- keep it showing live progress, but don't report a final pill or advance the
      // "X of Y mods done" count yet. Doing either here would flash a premature Restored/Failed
      // pill (and over-count mods done) for a mod that isn't actually finished.
      const done = rmfRowUnitCounts[rowIndex] - rmfRowSubItemsRemaining[rowIndex];
      rmfUpdateExtractRow(rowIndex + 1, 'extracting', 'Extracting…', `${done} of ${rmfRowUnitCounts[rowIndex]} part(s) done`);
      return;
    }
    // Last sub-item for this row just resolved (the common case: EVERY row that was never split
    // reaches here immediately, on its own one and only frame -- identical timing to before this
    // fix). rmfExtractProgressTotal/Done count ROWS, not raw items, so a mod split into a dozen
    // requests still only ever advances this bar by one.
    rmfExtractProgressDone += 1;
    const pct = rmfExtractProgressTotal > 0 ? Math.round((rmfExtractProgressDone / rmfExtractProgressTotal) * 100) : 0;
    $g('rmfExtractProgressBar').style.width = `${pct}%`;
    $g('rmfExtractLoadingText').textContent = `${rmfExtractProgressDone} of ${rmfExtractProgressTotal} mods done`;
    let detail;
    if (!accum.ok) detail = accum.error || 'Something went wrong.';
    // Only surfaced when NOTHING was extracted overall -- a split row where one slice was already
    // fixed but another genuinely needed extracting is a real restore, not an "already fixed" no-op.
    else if (accum.extractedCount === 0 && accum.note) detail = accum.note;
    else if (accum.extractedCount > 0) detail = `${accum.extractedCount} file(s) restored`;
    else detail = 'Archive downloaded';
    rmfUpdateExtractRow(rowIndex + 1, accum.ok ? 'enabled' : 'failed', accum.ok ? 'Restored' : 'Failed', detail);
  }
}

// rmfMergeSubItemResults: rebuild-missing-extract-chunking.js (loaded just before this file -- see
// index.html) -- own file, not defined here, alongside rmfChunkExtractItems/rmfSplitOversizedItems,
// so scripts/test-rmf-extract-chunking.js can require the real merge logic headlessly too.

function rmfApplyExtractResults(indices, results) {
  // The per-mod progress table stays visible with its final Restored/Failed pills through the whole
  // run (per this feature's own spec: "keep the row visible... until the existing results flow takes
  // over") -- hidden right here, at the exact point that flow takes over, not any earlier.
  $g('rmfExtractTableWrap').classList.add('hidden');
  $g('rmfExtractProgressBarWrap').classList.add('hidden');
  let restoredFiles = 0;
  let restoredMods = 0;
  // A 'missing' row resolved with ZERO newly-extracted files (2026-09-16, "a row that's actually
  // already fixed stays stuck showing N missing forever") -- extractOneMod's own "already fixed --
  // nothing was actually missing anymore" outcome, tracked separately so the banner below can say
  // what actually happened instead of "Successfully restored 0 files," which is technically true
  // but reads like nothing happened when the mod is, in fact, fully resolved.
  let alreadyFixedMods = 0;
  const failures = [];
  indices.forEach((idx, i) => {
    const result = results[i];
    const row = rmfState.rows[idx];
    if (!result) return;
    if (result.ok) {
      const extractedCount = (result.extracted || []).length;
      restoredFiles += extractedCount;
      restoredMods += 1;
      if (row.kind === 'missing') {
        if (extractedCount === 0) alreadyFixedMods += 1;
        // The server's OWN authoritative answer for "which of this row's destinations are still
        // actually missing right now" -- not inferred from `extracted` (wrong the moment `extracted`
        // is empty for a reason other than "extraction failed", which is exactly what the
        // "already fixed" outcome always returns, by design, since nothing needed copying). See
        // extractOneMod's own header comment (rebuild-missing-routes.js) for the full reasoning.
        row.missing = row.missing.filter((f) => (result.stillMissing || []).includes(f.destination));
      } else {
        // archive-missing, resolved via the shared download-then-extract chain -- nothing left to
        // track on this row (2026-09-02 v5 addendum).
        row._resolved = true;
      }
      rmfState.selected.delete(idx);
    } else {
      failures.push(`${escHtmlRmf(row.name)}: ${escHtmlRmf(result.error)}`);
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
  // Gated on hasSelectable (2026-09-02 fix; REVISED 2026-09-16, "a Couldn't Check row doesn't strand
  // the finished screen" -- reverted from a 2026-09-14 broadening to rmfHasRowsNeedingAttention() that
  // was wrong for this specific decision, see that function's own header comment), not the stricter
  // "rows.length === 0" -- a run that still has 'excepted'/'unchecked' rows left (rows.length > 0)
  // but nothing SELECTABLE remaining already reaches the real Done UI (rmfSetDoneUI below, stat
  // grid/badges hidden, Deploy prompt shown) -- the old rows-length check kept showing the plain
  // pre-Deploy-button wording in exactly that case, caught live by the director on a real
  // 13,016-file/5-mod restore that still had excepted rows. The 2026-09-14 broadening then caused the
  // SAME wrong wording to come back for the Couldn't-Check case specifically (a real mod that flow
  // hit: Better Skyrim Parties fixed, Nirnroot's own Open FOMOD left as the only row) -- fixed by
  // narrowing this specific check back to "selectable," while the all-clear-suppression check in
  // rmfRenderReport stays on the broader definition.
  const hasSelectable = rmfHasSelectableRows();
  if (failures.length === 0) {
    callout.className = 'callout callout--success';
    // allAlreadyFixed/summarySentence (2026-09-16, same fix as alreadyFixedMods above) -- "Successfully
    // restored 0 files across 1 mod" is technically true but reads like nothing happened, when the mod
    // is actually fully resolved. Say what really happened instead: nothing needed copying, or (mixed
    // batch) some mods got real files while others turned out to already be fine.
    const newlyFixedMods = restoredMods - alreadyFixedMods;
    const allAlreadyFixed = restoredMods > 0 && alreadyFixedMods === restoredMods;
    let summarySentence;
    if (allAlreadyFixed) {
      summarySentence = `${restoredMods} mod${restoredMods === 1 ? '' : 's'} already had all ${restoredMods === 1 ? 'its' : 'their'} files -- nothing needed restoring.`;
    } else if (alreadyFixedMods > 0) {
      summarySentence = `Restored ${restoredFiles.toLocaleString()} file${restoredFiles === 1 ? '' : 's'} across ${newlyFixedMods} mod${newlyFixedMods === 1 ? '' : 's'} (${alreadyFixedMods} more already had all ${alreadyFixedMods === 1 ? 'its' : 'their'} files).`;
    } else {
      summarySentence = `Restored ${restoredFiles.toLocaleString()} file${restoredFiles === 1 ? '' : 's'} across ${restoredMods} mod${restoredMods === 1 ? '' : 's'}.`;
    }
    // Exact copy per director's own spec, 2026-09-02 (revised from the 2026-09-01 wording) -- this
    // tool has its own real Deploy button right below (#rmfDeployPending), so the copy points at that
    // instead of Vortex's own Deploy Mods.
    callout.innerHTML = !hasSelectable
      ? `<div class="callout__title">🎉 ${allAlreadyFixed ? 'Already Fixed!' : 'Restoration Complete!'}</div><p>${summarySentence} Click <strong>Deploy</strong> to finish, or select another collection to restore more mods.</p>`
      : `${summarySentence} Open Vortex and click Deploy Mods to finish.`;
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
  // Both always hidden here -- "nothing missing"/"still missing" is folded into this function's own
  // extract-results callout above (allDone vs. partial), not rmfAllClearCallout/rmfSummaryCallout --
  // those belong to the fresh-scan path in rmfRenderReport and are never given fresh content here.
  $g('rmfAllClearCallout').classList.add('hidden');
  $g('rmfSummaryCallout').classList.add('hidden');
  // Single shared toggle (stepper/Done UI/selection bar/table/actions-help/Couldn't-Check attention)
  // -- called AFTER rmfAnyRestoreThisRun is finalized above so rmfSetDoneUI's own Deploy-panel
  // wording picks up the right restoredThisRun value; see this function's own header comment.
  rmfRefreshResultsVisibility();
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
      rmfState.rows[idx] = { kind: 'missing', collectionModId: row.collectionModId, collectionName: row.collectionName, collectionDomainName: row.collectionDomainName, ...result };
    } else if (result.bucket === 'ok') {
      rmfState.rows = rmfState.rows.filter((_, i) => i !== idx);
    } else {
      rmfState.rows[idx] = { kind: 'archive-missing', collectionModId: row.collectionModId, collectionName: row.collectionName, collectionDomainName: row.collectionDomainName, ...result };
    }
    rmfState.selected = new Set([...rmfState.selected].map((i) => (i === idx ? null : i)).filter((i) => i !== null));
    rmfRenderRows();

    // Real gap fixed 2026-08-25: a Download Archive that resolves the LAST selectable row (this
    // mod's archive turns out to have nothing missing -- result.bucket === 'ok', the row is just
    // dropped above) used to leave the active-work UI (Select All bar, empty table) sitting there
    // with nothing left to act on, instead of switching to the same "all clear" success screen a
    // fresh scan or a completed Extract already shows. Same rmfHasSelectableRows() this file's other
    // two "reached the end of the review" spots use -- REVISED 2026-09-16, see
    // rmfHasSelectableRows()'s own header comment for why this reverted from the 2026-09-14
    // broadening to rmfHasRowsNeedingAttention().
    const { hasSelectable, hasAttention } = rmfRefreshResultsVisibility();
    if (!hasSelectable && !hasAttention) {
      // Never claim "No Missing Files Detected" while a Couldn't Check row remains (hasAttention) --
      // same rule rmfRenderReport's own summary-callout logic follows.
      const summary = $g('rmfSummaryCallout');
      summary.className = 'callout callout--success';
      summary.innerHTML = '<div class="callout__title">🎉 No Missing Files Detected</div>'
        + '<p>All mods are complete. No repairs are needed in your staging folder. Click <strong>Deploy</strong> below if you haven\'t deployed since your last change.</p>';
      summary.classList.remove('hidden');
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(e, $g('rmfScanError'), () => rmfDownloadArchive(row, idx, btn));
  }
}

// ---------- Import (non-Nexus archive-missing rows, 2026-09-17) ----------
// Ports Rebuild Collection's own already-shipped off-site Import flow (lib/collection-runner.js's
// importOffSiteArchive/extractImportedOffSiteMod, backed by lib/offsite-import-map.js +
// classifyMod's overrideArchivePath) rather than building a second one -- see
// web/public/work-through-app.js's own importOffSite() for the closest existing analog (a live
// report table, resolve-in-place), which this mirrors more closely than the Plan page's own
// pre-run version (web/rebuild-routes.js's /import-offsite-archive, which can't extract anything
// yet since there's no report row to update at that point).
async function rmfImportOffsite(row, idx, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Importing…';
  let response;
  try {
    response = await rmfApi('POST', '/api/rebuild-missing/import-offsite', {
      collectionModId: row.collectionModId, name: row.name,
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(e, $g('rmfScanError'), () => rmfImportOffsite(row, idx, btn));
    return;
  }
  if (response.cancelled) {
    // The user closed the file picker without choosing anything -- the server never even called
    // importOffSiteArchive in this case, so the row just reverts, no half-state to clean up.
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  if (response.outcome.kind === 'REBUILD') {
    // Fully resolved -- drops out of the report entirely, same convention as a fully-fixed row
    // elsewhere in this file (rmfApplyExtractResults, rmfInstallFomod's own onDone).
    rmfState.rows = rmfState.rows.filter((_, i) => i !== idx);
    rmfAnyRestoreThisRun = true; // gates the Deploy prompt -- see its own header comment
    rmfRenderRows();
    // Same "reached the end of the review" fallback rmfDownloadArchive's own success path uses.
    const { hasSelectable, hasAttention } = rmfRefreshResultsVisibility();
    if (!hasSelectable && !hasAttention) {
      const summary = $g('rmfSummaryCallout');
      summary.className = 'callout callout--success';
      summary.innerHTML = '<div class="callout__title">🎉 No Missing Files Detected</div>'
        + '<p>All mods are complete. No repairs are needed in your staging folder. Click <strong>Deploy</strong> below if you haven\'t deployed since your last change.</p>';
      summary.classList.remove('hidden');
    }
  } else {
    // A genuine non-REBUILD outcome (most likely Rebuild Collection's own "resolve mismatch" case --
    // the freshly-imported archive's content doesn't cleanly match what's already in staging, which
    // this tool has no resolve-mismatch picker for). The row stays exactly as it was -- still
    // archive-missing, Browse still offered for another attempt with a different file -- and the
    // reason surfaces in the shared error banner, same treatment rmfDownloadArchive gives a real
    // thrown error.
    btn.disabled = false;
    btn.textContent = original;
    rmfHandleError(new Error(response.outcome.detail || 'Import did not fully resolve this mod.'), $g('rmfScanError'), () => rmfImportOffsite(row, idx, btn));
  }
}

// ---------- Install (Open FOMOD rows, 2026-09-17; rewritten to a clean reinstall same day) ----------
// A real Open FOMOD Couldn't Check row's own Install action -- peeks the mod's real FOMOD via
// /fomod-picker-data, drives the SAME shared picker Update Collection already uses
// (web/public/fomod-picker.js, opened with reinstallWarning:true since this action replaces the
// mod's current files rather than Update Collection's own additive Apply flow), then submits the
// finished picks to /install-fomod -- now a full clean reinstall (runner.installOpenFomodMod(), the
// exact mechanism Rebuild Collection's own Install button already uses), not the old
// additive-only extract. Cancel in the picker changes nothing here -- the button just re-enables, no
// request is ever sent.
//
// Any failure -- the picker-data fetch, or the install-fomod call itself -- updates this row's own
// `reason` field and re-renders, instead of the shared #rmfScanError banner (which sits at the top
// of the report, disconnected from the row that actually failed, and isn't even present on the Done
// screen this button lives on).
async function rmfInstallFomod(row, idx, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Loading…';
  let needs;
  try {
    ({ needs } = await rmfApi('POST', '/api/rebuild-missing/fomod-picker-data', {
      collectionModId: row.collectionModId, modId: row.modId, fileId: row.fileId,
    }));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    rmfState.rows[idx] = { ...row, reason: e.message || "Couldn't load this mod's install options." };
    rmfRenderRows();
    return;
  }
  btn.disabled = false;
  btn.textContent = original;
  // Set true only if this session's own "Install Anyway" override (a real schema-validation
  // failure, 2026-09-15) was actually used -- forwarded on Finish so the resulting recorded choices
  // carry it too (buildFomodChoicesFromPicks), and a later background rebuild of this same mod
  // doesn't re-block on the same already-confirmed archive.
  let ignoreFomodValidationUsed = false;
  showFomodPicker(needs, {
    reinstallWarning: true,
    onIgnoreValidation: async () => {
      ignoreFomodValidationUsed = true;
      const { needs: retried } = await rmfApi('POST', '/api/rebuild-missing/fomod-picker-data', {
        collectionModId: row.collectionModId, modId: row.modId, fileId: row.fileId, ignoreFomodValidation: true,
      });
      return retried[0];
    },
    onDone: async (picksByModId) => {
      btn.disabled = true;
      btn.textContent = 'Installing…';
      try {
        const { result } = await rmfApi('POST', '/api/rebuild-missing/install-fomod', {
          collectionModId: row.collectionModId, modId: row.modId, fileId: row.fileId,
          picks: picksByModId[String(row.modId)] || {}, ignoreFomodValidation: ignoreFomodValidationUsed,
        });
        if (result.ok) {
          // Fully resolved -- drops out of the report entirely, same as a fully-fixed 'missing' row
          // (rmfApplyExtractResults' own convention).
          rmfState.rows = rmfState.rows.filter((_, i) => i !== idx);
          rmfAnyRestoreThisRun = true; // gates the Deploy prompt -- see its own header comment
        } else {
          // A real rebuild failure (locked folder, extraction failure, ...) or a non-REBUILD
          // classification outcome (e.g. the archive went missing between the scan and this click).
          // The two known statuses below get their own complete, this-tool-specific line (Copy by
          // Gemini, 2026-09) instead of the shared lib/rebuild-mod.js detail text, which references
          // Rebuild Collection's own "Restore & Retry" button that this tool doesn't have.
          const label = statusLabel(result.status);
          let reason;
          if (result.status === 'CRITICAL_MANUAL_RESTORE_NEEDED') {
            reason = 'Needs restore — Both your original and new files are safe on disk. Try Install again; if it keeps failing, check if another program has a file open in your staging folder.';
          } else if (result.status === 'FAILED_FOLDER_LOCKED_NOT_TOUCHED') {
            reason = "Folder locked — Couldn't swap in the new files because a folder was locked. Your original files are untouched — close any open folders or apps and try Install again.";
          } else {
            reason = `${label} — ${result.detail || 'Install did not fully resolve this mod.'}`;
          }
          rmfState.rows[idx] = { ...row, reason };
        }
        rmfState.selected = new Set([...rmfState.selected].map((i) => (i === idx ? null : i)).filter((i) => i !== null));
        rmfRenderRows();
        rmfRefreshResultsVisibility();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = original;
        rmfState.rows[idx] = { ...row, reason: e.message || 'Install failed.' };
        rmfRenderRows();
      }
    },
  });
}

// ---------- Open Staging Folder ----------

async function rmfOpenStagingFolder(row) {
  try {
    await rmfApi('POST', '/api/rebuild-missing/open-staging-folder', { targetFolderName: row.targetFolderName });
  } catch (e) {
    rmfHandleError(e, $g('rmfScanError'), () => rmfOpenStagingFolder(row));
  }
}

// ---------- Deploy (Done state, 2026-09-01, unified 2026-09-14) ----------
// Real fire-and-poll deploy, replacing the old static "External Changes" warning -- director's own
// ask: "add Deploy button... replace with our standard deploy modal used elsewhere (Update
// collection)." The actual poll loop (percent/text, stall-hint, rule-cycle detection) now lives in
// deploy-panel.js's shared startDeploy (2026-09-14, "the same Deploy step on every Done screen") --
// Rebuild Collection's and Update Collection v2's own Deploy panels use the identical engine, backed
// by the one shared web/deploy-routes.js (/api/deploy/all + /api/deploy/all/progress).

// noRetry (matching Update Collection v2's own ucv2ShowDeployResult): a real rule cycle comes right
// back on a Retry Deploy click even though that path never re-touches rules at all -- this isn't
// something a same-tool retry can ever fix, so the button is omitted entirely for that one specific
// failure. The real fix has to happen in Vortex/Cycle Helper.
function rmfShowDeployResult(kind, message, noRetry) {
  const box = $g('rmfDeployResult');
  box.classList.remove('hidden');
  box.className = `callout callout--${kind === 'success' ? 'success' : 'warning'}`;
  box.innerHTML = '';
  if (kind === 'success') {
    // "After a successful deploy, the Done screen shows one All Set banner" (2026-09-15) -- a
    // successful deploy used to leave whichever result banner got this screen to Done in the first
    // place (rmfSummaryCallout's "No Missing Files Detected", rmfAllClearCallout's "All Files
    // Present", or rmfExtractResultsCallout's "Restoration Complete!") sitting right above this
    // box's own "Deploy complete" -- two banners saying overlapping things at once (director's own
    // report, three counting the Deploy panel itself, though that part was already supposed to be
    // hidden by rmfStartDeploy's own onStart/onDone -- these two extra hides are belt-and-suspenders
    // so this function is correct even if ever called on its own). rmfCouldntCheckCallout is
    // deliberately left alone -- a Couldn't Check row is unfinished work, not a result banner, same
    // reasoning as Rebuild Collection's own locked/critical attention rows (see TECHNICAL.md).
    // Everything hidden here comes back the instant a fresh scan runs (rmfRenderReport) or
    // rmfResetOnEntry fires (Back to Collections) -- neither of those two banners nor this one is
    // ever re-shown by anything else in between.
    $g('rmfSummaryCallout').classList.add('hidden');
    $g('rmfAllClearCallout').classList.add('hidden');
    $g('rmfExtractResultsCallout').classList.add('hidden');
    $g('rmfDeployPending').classList.add('hidden');
    $g('rmfDeployProgress').classList.add('hidden');
    box.appendChild(el('div', { class: 'callout__title' }, "🎉 All Set — It's Game Time!"));
    box.appendChild(el('p', {}, rmfAnyRestoreThisRun
      ? 'All missing files have been restored and deployed. Your game is ready to launch!'
      : 'All your files are present and deployed. Your game is ready to launch!'));
    return;
  }
  box.appendChild(el('div', { class: 'callout__title' }, '⚠️ Deploy failed'));
  box.appendChild(el('p', {}, message || 'Vortex could not complete the deployment. You can try again from here, or open Vortex and click Deploy Mods directly.'));
  if (!noRetry) {
    const retry = el('button', { class: 'btn btn--primary btn--small' }, 'Retry Deploy');
    retry.addEventListener('click', () => rmfStartDeploy());
    box.appendChild(el('div', { class: 'row-actions' }, retry));
  }
}

function rmfStartDeploy() {
  startDeploy('/api/deploy', rmfApi, {
    onStart: () => {
      $g('rmfDeployResult').classList.add('hidden');
      $g('rmfDeployPending').classList.add('hidden');
      $g('rmfDeployProgress').classList.remove('hidden');
      $g('rmfDeployPhase').textContent = 'Starting…';
      $g('rmfDeployBar').style.width = '0%';
      // Same precaution Update Collection v2's own Deploy already established (2026-08-28,
      // director's own catch): leaving this screen mid-deploy doesn't stop the real Vortex deploy
      // already running server-side, but it does orphan this screen's own live progress/result
      // reporting for it, and Deploy is real file I/O that shouldn't be walked away from blind.
      $g('rmfBackToPickerBtn').disabled = true;
    },
    onError: (e) => {
      $g('rmfDeployProgress').classList.add('hidden');
      rmfShowDeployResult('error', e.message);
      $g('rmfBackToPickerBtn').disabled = false;
    },
    onTick: (progress) => {
      if (progress && typeof progress.percent === 'number') {
        $g('rmfDeployBar').style.width = `${Math.round(progress.percent)}%`;
      }
      if (progress && progress.text) $g('rmfDeployPhase').textContent = progress.text;
    },
    onStall: (show, message) => {
      const hint = $g('rmfDeployStallHint');
      hint.innerHTML = message || '⚠️ Vortex is taking longer than usual to finish. Please be patient while it finishes.';
      hint.classList.toggle('hidden', !show);
    },
    onDone: (progress) => {
      $g('rmfDeployProgress').classList.add('hidden');
      rmfShowDeployResult(progress.error ? 'error' : 'success', themedCycleMessage(progress.error, progress.code, 'deploy-blocked-by-cycles'), progress.code === 'deploy-blocked-by-cycles');
      $g('rmfBackToPickerBtn').disabled = false;
    },
  });
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
  // Mid-operation guard ("coming back from another tool starts clean", 2026-09-17): this whole app
  // is ONE page -- leaving to another tool never destroys a running scan/extraction/deploy, it just
  // hides this screen behind CSS, and the operation keeps going for real underneath. If one is still
  // genuinely in flight when the user comes back, leave the screen exactly as it is (still showing
  // live progress) instead of yanking it out from under them: closing rmfState.eventSource/
  // extractEventSource here would silently stop this screen from ever hearing the rest of that
  // scan/extraction's own events, and resetting mid-deploy would abandon a real, still-running
  // Vortex deploy's own progress/result reporting (deploy itself can't be stopped from here either
  // way -- see rmfStartDeploy's own onStart comment). Never blocks a genuinely-finished run, though --
  // 'scan-complete'/'scan-error'/the extract-complete equivalent all already null their own
  // eventSource/extractEventSource the moment they finish, and a finished/failed deploy already
  // hides its own progress box -- so by the time any of those three are still true, something is
  // really still running.
  if (rmfState.eventSource || rmfState.extractEventSource || !$g('rmfDeployProgress').classList.contains('hidden')) return;
  // Real, pre-existing bug found live 2026-09-16: this called a never-defined rmfStopDeployPolling(),
  // throwing a ReferenceError on every re-entry into this page. Vestigial from before Deploy moved to
  // the shared deploy-panel.js's own event-driven startDeploy (2026-09-14, see this file's own "Deploy
  // (Done state)" header comment) -- there's no client-side poll interval or connection object left
  // to stop; rmfDeployPending/Progress/Result are already explicitly hidden two lines below.
  rmfAnyRestoreThisRun = false;
  $g('rmfDeployPending').classList.add('hidden');
  $g('rmfDeployProgress').classList.add('hidden');
  $g('rmfDeployResult').classList.add('hidden');
  rmfState.picked.clear();
  rmfUpdatePickCount();
  rmfState.collectionsById.clear();
  rmfState.rows = [];
  rmfState.selected.clear();
  rmfResetKindFilterToDefault();
  rmfRenderStepper(0);
  $g('rmfPickerView').classList.remove('hidden');
  $g('rmfReportView').classList.add('hidden');
  $g('rmfBackToPickerBtn').classList.add('hidden'); // step 1 (the picker) has no Cancel/Back of its own
  rmfLoadCollections();
}
window.rmfResetOnEntry = rmfResetOnEntry;
