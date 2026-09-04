'use strict';
// Clear Update Flags (Utilities area) -- Vortex's own "Update available" badge can stay lit for a
// collection member mod even when the collection deliberately pins that exact version. This tool
// clears the stale flag directly through the Helper's own real live-state write -- never touches an
// installed file. Real logic lives in lib/vortex-update-flags.js; see that file's own header comment
// for the full design writeup. Own tiny helpers, same "self-contained area" convention already used
// by cleanup-app.js/reports-rulesgen-app.js.
//
// Picker UI (2026-08-23, real architecture change): mirrors Rebuild Missing Files' own real card-grid
// picker (rebuild-missing-app.js's rmfRenderPickerGroup) directly -- same .coll-card/.picker-grid/
// .group-head markup and classes, same Select all/Invert selection/Clear selection controls above it
// -- rather than the flat checkbox <li> list this tool originally shipped with. Every real Installed/
// Workshop collection shows up as its own card regardless of whether it currently has a pending flag
// (flaggedCount is shown as context, not used to filter); "Mods not part of any collection" stays its
// own single row, unchanged in spirit from before.

function cufG(id) { return document.getElementById(id); }

function cufEl(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    // Coerces ANYTHING that isn't already a real Node (a number, an object, whatever) into a text
    // node too, not just strings -- 2026-08-23, real belt-and-suspenders fix found alongside the
    // actual data-model bug that used to hand this a bare number. Never a substitute for getting the
    // data right, just makes any FUTURE mistake like it degrade to showing the wrong value as text
    // instead of a hard crash.
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function cufApi(method, path, body) {
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

function cufHandleError(e) {
  if (e.status === 400 && e.body?.error === 'not-configured') {
    cufG('cufNotConfigured').textContent = e.message;
    cufG('cufNotConfigured').classList.remove('hidden');
    return;
  }
  if (e.status === 409 && e.body?.error === 'helper-unavailable') {
    const box = cufG('cufCriticalError');
    box.innerHTML = '';
    box.appendChild(cufEl('div', { class: 'callout__title' }, '🛑 Vortex Connection Required'));
    box.appendChild(cufEl('p', {}, 'This tool requires a live connection to the Vortex Collection Helper extension to run.'));
    box.appendChild(cufEl('ul', {}, [
      cufEl('li', {}, [cufEl('strong', {}, 'If you already have the extension installed:'), ' Make sure Vortex is actively running.']),
      cufEl('li', {}, [cufEl('strong', {}, "If you haven't installed it yet:"), ' Install the Vortex Collection Helper extension into Vortex, restart Vortex, and then launch this tool again.']),
    ]));
    const retryBtn = cufEl('button', { class: 'btn btn--ghost btn--small' }, 'Retry');
    retryBtn.addEventListener('click', () => runClearUpdateFlagsList());
    box.appendChild(cufEl('div', { style: 'display:flex; justify-content:flex-end; margin-top:10px;' }, [retryBtn]));
    box.classList.remove('hidden');
    return;
  }
  cufG('cufCriticalError').textContent = e.message || 'Something went wrong.';
  cufG('cufCriticalError').classList.remove('hidden');
}

// Reflects every selection checkbox's own real state back onto the header "Select all" checkbox --
// all checked -> on, anything else -> off. Scoped to #cufMain so it covers both card grids AND the
// standalone row uniformly, wherever they currently live in the DOM.
function cufSyncSelectAllCheckbox() {
  const boxes = [...document.querySelectorAll('#cufMain .cuf-row-check')];
  cufG('cufSelectAllInput').checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
}

// Counts DISTINCT mods, not the sum of each checked card's own flaggedCount (2026-08-23, real fix).
// A mod can genuinely belong to more than one collection -- live-confirmed, "AltTabFix 1.3.1" is a
// real member of both "Dragonborn UI for GTS" and "My QOL and Utilities" -- so summing counted it
// twice and the button read one higher than the number of mods the server would actually clear.
// Each checkbox carries its own real modId list (attached as a plain JS property in the renderers
// below, not a data- attribute: these are arrays, and stringifying them into the DOM buys nothing),
// so the union here matches resolveModIdsToClear's own de-duplicated result exactly.
function cufUpdateCheckedCount() {
  const checks = [...document.querySelectorAll('#cufMain .cuf-row-check')];
  const distinct = new Set();
  for (const cb of checks) {
    if (!cb.checked) continue;
    for (const id of cb.cufModIds || []) distinct.add(id);
  }
  cufG('cufCheckedCount').textContent = String(distinct.size);
  cufG('cufClearBtn').disabled = distinct.size === 0;
}

// One real card per collection -- same shape as Rebuild Missing Files' own rmfRenderPickerGroup
// (label wrapping a checkbox + a .meta block with .name/.sub), plus one addition beyond what that
// tool's own cards show: how many of THIS collection's own mods are currently flagged, e.g.
// "163 mods — 162 flagged for update". A card with a real member count but zero flagged mods still
// shows honestly ("0 flagged for update") rather than being hidden -- the flag count is context here,
// not a filter (every real collection shows up regardless). It just isn't pre-checked (2026-08-23,
// director's own ask): checking a zero-flag collection would clear nothing, so defaulting it on just
// adds noise and an inflated "everything selected" feel -- the user can still check it by hand.
function cufCollectionCard(item) {
  const checkbox = cufEl('input', {
    type: 'checkbox', class: 'cuf-row-check', 'data-kind': 'collection',
    'data-collection-id': item.modId,
  });
  checkbox.cufModIds = item.flaggedModIds || [];
  checkbox.checked = item.flaggedCount > 0;
  const subLine = cufEl('div', { class: 'sub' }, `${item.modCount} mod${item.modCount === 1 ? '' : 's'} — ${item.flaggedCount} flagged for update`);
  const card = cufEl('label', { class: item.flaggedCount > 0 ? 'coll-card sel' : 'coll-card' }, [
    checkbox,
    cufEl('div', { class: 'meta' }, [
      cufEl('div', { class: 'name' }, item.name),
      subLine,
    ]),
  ]);
  checkbox.addEventListener('change', () => {
    card.classList.toggle('sel', checkbox.checked);
    cufUpdateCheckedCount();
    cufSyncSelectAllCheckbox();
  });
  return card;
}

function cufRenderPickerGroup(sectionId, gridId, countId, items) {
  cufG(sectionId).classList.toggle('hidden', items.length === 0);
  if (items.length === 0) return;
  cufG(countId).textContent = `${items.length} collection${items.length === 1 ? '' : 's'}`;
  const grid = cufG(gridId);
  grid.innerHTML = '';
  for (const item of items) grid.appendChild(cufCollectionCard(item));
}

// Standalone stays its own single row (same shape as before this task) -- a real member count, one
// checkbox covering all of it, not converted into cards.
function cufRenderStandalone(standalone) {
  cufG('cufStandaloneSection').classList.toggle('hidden', standalone.length === 0);
  if (standalone.length === 0) return;
  const checkbox = cufEl('input', {
    type: 'checkbox', class: 'cuf-row-check', 'data-kind': 'standalone',
  });
  checkbox.cufModIds = standalone.map((m) => m.modId);
  checkbox.checked = true;
  checkbox.addEventListener('change', () => {
    cufUpdateCheckedCount();
    cufSyncSelectAllCheckbox();
  });
  const label = cufEl('label', {}, [checkbox, ' ', cufEl('strong', {}, 'Mods not part of any collection'), ` (${standalone.length})`]);
  const list = cufG('cufStandaloneList');
  list.innerHTML = '';
  list.appendChild(cufEl('li', {}, [label]));
}

function cufRenderPicker(data) {
  cufRenderPickerGroup('cufInstalledSection', 'cufInstalledGrid', 'cufInstalledCount', data.installed);
  cufRenderPickerGroup('cufWorkshopSection', 'cufWorkshopGrid', 'cufWorkshopCount', data.workshop);
  cufRenderStandalone(data.standalone);
  // Not a hardcoded true anymore -- zero-flag collections now start unchecked (see
  // cufCollectionCard), so "Select all" needs to reflect the real per-row state honestly rather than
  // claim everything's selected when it isn't.
  cufSyncSelectAllCheckbox();
  cufUpdateCheckedCount();
  const anyRows = data.installed.length > 0 || data.workshop.length > 0 || data.standalone.length > 0;
  cufG('cufMain').classList.toggle('hidden', !anyRows);
  cufG('cufEmpty').classList.toggle('hidden', anyRows);
}

// `silent` (2026-08-23, real fix): a real 4,771-mod live clear surfaced a stray "Cannot set
// properties of null" error box sitting ABOVE an otherwise-correctly-rendered success box. Root
// cause: the post-clear flow calls this to refresh the picker BEFORE rendering the clear's own
// result, and this function's own default behavior on a refresh failure is to call cufHandleError --
// which competes visually with the result about to render right after, and reads as a confusing
// partial-error screen instead of either a clean success or a clear, real failure. `{ silent: true }`
// (used only by that post-completion refresh, and restore's own identical refresh-then-render-result
// sequence below) logs a refresh failure to the console instead of surfacing a competing critical-
// error box -- the operation's own real result is already known and about to render regardless of
// whether the picker itself managed to refresh. Every other caller (the helper-unavailable Retry
// button, the initial page load) keeps today's default: a refresh failure IS the whole story there,
// so it still shows plainly.
async function runClearUpdateFlagsList({ silent = false } = {}) {
  cufG('cufCriticalError').classList.add('hidden');
  cufG('cufNotConfigured').classList.add('hidden');
  cufG('cufEmpty').classList.add('hidden');
  cufG('cufMain').classList.add('hidden');
  cufG('cufResult').classList.add('hidden');
  cufG('cufLoading').classList.remove('hidden');
  try {
    const data = await cufApi('GET', '/api/clear-update-flags/list');
    cufG('cufLoading').classList.add('hidden');
    cufRenderPicker(data);
  } catch (e) {
    cufG('cufLoading').classList.add('hidden');
    if (silent) {
      console.error('[Clear Update Flags] Refreshing the picker failed:', e);
    } else {
      cufHandleError(e);
    }
  }
}

cufG('cufSelectAllInput').addEventListener('change', (ev) => {
  document.querySelectorAll('#cufMain .cuf-row-check').forEach((cb) => {
    cb.checked = ev.target.checked;
    const card = cb.closest('.coll-card');
    if (card) card.classList.toggle('sel', ev.target.checked);
  });
  cufUpdateCheckedCount();
});

// Invert selection / Clear selection -- same real controls Archive Finder's own selection model
// already established (afInvertSelectionBtn/afClearSelectionBtn), matching DESIGN.md's current
// "Select all · Invert selection · Clear selection" standard for every select-and-act list. This
// tool's own selection state is just each checkbox's real .checked -- a plain DOM read, not Archive
// Finder's own Set (that shape exists there for a paginated, cross-page-persistent selection, which
// this short, unpaginated picker doesn't need).
cufG('cufInvertSelectionBtn').addEventListener('click', () => {
  document.querySelectorAll('#cufMain .cuf-row-check').forEach((cb) => {
    cb.checked = !cb.checked;
    const card = cb.closest('.coll-card');
    if (card) card.classList.toggle('sel', cb.checked);
  });
  cufUpdateCheckedCount();
  cufSyncSelectAllCheckbox();
});
cufG('cufClearSelectionBtn').addEventListener('click', () => {
  document.querySelectorAll('#cufMain .cuf-row-check').forEach((cb) => {
    cb.checked = false;
    const card = cb.closest('.coll-card');
    if (card) card.classList.toggle('sel', false);
  });
  cufUpdateCheckedCount();
  cufSyncSelectAllCheckbox();
});

// Refresh -- re-runs the exact same real live-Helper read the page already does on load. There is no
// cache to invalidate here (GET /api/clear-update-flags/list always makes a genuine live
// helperClient.getAllMods() call, never a stored snapshot), so this button's real job is letting you
// re-check the numbers after changing something in Vortex itself, without having to leave the page
// and come back. Deliberately NOT silent: a refusal here (Vortex closed, Helper gone) IS the whole
// story of an explicitly-clicked refresh, so it surfaces plainly like the initial load does.
cufG('cufRefreshBtn').addEventListener('click', () => runClearUpdateFlagsList());

// The exact ONE backup a completed clear is tied to -- set by cufRenderResult below, read by the
// Restore button's own click handler. Never a picker of older backups (director explicitly considered
// and declined that for now -- see TODO.md's vortex-collection-tools "ideas" section).
let cufLastBackupPath = null;
let cufLastBackupTotal = 0;

function cufRenderResult(data) {
  const failed = (data.results || []).filter((r) => r.ok === false);
  const succeeded = data.results.length - failed.length;
  const allOk = failed.length === 0;
  const result = cufG('cufResult');
  const restoreRow = cufG('cufRestoreRow');
  if (data.cancelled) {
    // A cancelled run is a real, honest partial success, not a failure -- whatever mods were already
    // cleared genuinely stayed cleared (their Helper writes already happened), so this deliberately
    // does NOT use the warning styling/copy below. New copy (2026-08-23), not a reuse of the
    // full-success/partial-failure wording -- flagged in the handoff for a look before shipping.
    // Untouched by this task's own copy/backup-line changes below (out of scope, see handoff).
    result.className = 'callout callout--info';
    cufG('cufResultTitle').textContent = `⏸ Stopped after clearing ${succeeded} of ${data.total} mods`;
    cufG('cufResultSummary').textContent = `You cancelled before the rest were processed. The ${succeeded} mod${succeeded === 1 ? '' : 's'} already cleared ${succeeded === 1 ? 'is' : 'are'} genuinely done — cancelling doesn't undo that. A backup of this run was saved, so you can pick up the rest anytime.`;
    restoreRow.classList.add('hidden');
  } else {
    // Success pill is now real green (DESIGN.md's Color & severity system) -- the bare, uncolored
    // `.callout` read as grey/nothing-happened, confirmed wrong for a genuinely completed action.
    result.className = allOk ? 'callout callout--success' : 'callout callout--warning';
    cufG('cufResultTitle').textContent = allOk ? '🎉 Update flags cleared' : '⚠️ Cleared with some problems';
    // Full-success copy is the director's own exact words (2026-08-23) -- used verbatim, comma-format
    // the count. Partial-failure keeps its own existing, still-accurate framing -- just drops its
    // "A backup..." clause the same way full-success does, now that the backup path is never shown on
    // screen (still tracked in JS state below for Restore; just not printed).
    cufG('cufResultSummary').textContent = allOk
      ? `Cleared update flags for ${succeeded.toLocaleString()} mods. Check Vortex to confirm your update badges are gone. If you change your mind or want to revert, click Restore to bring back your original update flags.`
      : `Cleared update flags for ${succeeded} of ${data.results.length} mods -- ${failed.length} couldn't be cleared (see below).`;
    cufLastBackupPath = data.backupPath;
    cufLastBackupTotal = data.total || data.results.length;
    restoreRow.classList.remove('hidden');
  }
  const problemsList = cufG('cufResultProblems');
  if (failed.length > 0) {
    problemsList.innerHTML = '';
    failed.forEach((r) => problemsList.appendChild(cufEl('li', {}, `${r.modId}: ${r.error || 'Failed.'}`)));
    problemsList.classList.remove('hidden');
  } else {
    problemsList.classList.add('hidden');
  }
  result.classList.remove('hidden');
}

// Restore (2026-08-23) -- the follow-up lib/vortex-update-flags.js's own backupUpdateFlags header
// comment always said was still owed: "a restore is just replaying this file's own values back
// through a real setModAttributes call per mod, in reverse". Confirm step mirrors Update Collection's
// own syncRestoreBackupModal (sync-app.js) for shape/copy conventions -- same modal-overlay/.modal/
// .modal-actions structure, same "Cancel" + primary action-verb button -- minus its dropdown, since
// this restore always targets the ONE backup tied to the clear that just completed. Serious register
// (plain-language-writer skill) throughout: this is a real, live write to Vortex's own state, same as
// the clear itself.
function cufShowRestoreConfirm(backupPath, total) {
  cufG('cufRestoreConfirmModalText').textContent = `This will bring back the original update flags for the ${total.toLocaleString()} mods saved in this backup, completely undoing the previous clear.`;
  cufG('cufRestoreConfirmModalText2').textContent = `We’ll apply these changes straight to Vortex just like before.`;
  cufG('cufRestoreConfirmModal').classList.remove('hidden');
}

function cufRenderRestoreResult(results) {
  const failed = (results || []).filter((r) => r.ok === false);
  const succeeded = results.length - failed.length;
  const allOk = failed.length === 0;
  const result = cufG('cufResult');
  result.className = allOk ? 'callout callout--success' : 'callout callout--warning';
  cufG('cufResultTitle').textContent = allOk ? '🎉 Backup restored' : '⚠️ Restored with some problems';
  cufG('cufResultSummary').textContent = allOk
    ? `Restored the original update flags for ${succeeded.toLocaleString()} mods.`
    : `Restored ${succeeded} of ${results.length} mods -- ${failed.length} couldn't be restored (see below).`;
  const problemsList = cufG('cufResultProblems');
  if (failed.length > 0) {
    problemsList.innerHTML = '';
    failed.forEach((r) => problemsList.appendChild(cufEl('li', {}, `${r.modId}: ${r.error || 'Failed.'}`)));
    problemsList.classList.remove('hidden');
  } else {
    problemsList.classList.add('hidden');
  }
  // One-shot -- this exact backup was just replayed back; re-showing Restore here would just invite
  // restoring the same snapshot again for no reason. The backup file itself is untouched on disk.
  cufG('cufRestoreRow').classList.add('hidden');
  result.classList.remove('hidden');
}

cufG('cufRestoreBtn').addEventListener('click', () => {
  if (!cufLastBackupPath) return;
  cufShowRestoreConfirm(cufLastBackupPath, cufLastBackupTotal);
});
cufG('cufRestoreConfirmCancelBtn').addEventListener('click', () => {
  cufG('cufRestoreConfirmModal').classList.add('hidden');
});
cufG('cufRestoreConfirmOkBtn').addEventListener('click', async () => {
  const backupPath = cufLastBackupPath;
  cufG('cufRestoreConfirmModal').classList.add('hidden');
  if (!backupPath) return;
  const btn = cufG('cufRestoreBtn');
  btn.disabled = true;
  btn.textContent = 'Restoring…';
  cufG('cufCriticalError').classList.add('hidden');
  try {
    const data = await cufApi('POST', '/api/clear-update-flags/restore', { backupPath });
    // Refresh the picker FIRST, silently -- see runClearUpdateFlagsList's own header comment for why
    // a refresh failure here must never compete with the restore result about to render right after.
    await runClearUpdateFlagsList({ silent: true });
    cufRenderRestoreResult(data.results);
  } catch (e) {
    cufHandleError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Restore';
  }
});

// Real SSE-streamed progress (2026-08-23) -- POST /clear now only does the fast resolve+backup step
// synchronously, then returns as soon as the real per-mod loop has genuinely started (mirroring
// PGPatcher's own /build kick-off-then-stream shape, web/pgpatcher-routes.js). GET /clear/events
// streams a real progress event per mod, exactly like pgpHandleBuildEvent's own 'progress' handling
// in pgpatcher-app.js -- reused here rather than inventing a second SSE-consumption pattern.
let cufClearEventSource = null;

function cufSetPickerInteractive(enabled) {
  document.querySelectorAll('#cufMain .cuf-row-check').forEach((cb) => { cb.disabled = !enabled; });
  cufG('cufSelectAllInput').disabled = !enabled;
  cufG('cufInvertSelectionBtn').disabled = !enabled;
  cufG('cufClearSelectionBtn').disabled = !enabled;
  cufG('cufRefreshBtn').disabled = !enabled;
}

// Same "N / M — {phase}" shape as PGPatcher's own pgpSetBuildingPhase (pgpatcher-app.js) -- per
// UX-PRINCIPLES.md's "show the phase name and the count together" rule.
function cufSetClearProgress(current, total) {
  cufG('cufClearProgressPhase').textContent = current && total
    ? `${current} / ${total} — Clearing update flags…`
    : 'Starting…';
  if (current && total) {
    cufG('cufClearProgressBar').style.width = `${Math.round((current / total) * 100)}%`;
  }
}

function cufFinishClearStream() {
  if (cufClearEventSource) { cufClearEventSource.close(); cufClearEventSource = null; }
  cufG('cufClearProgress').classList.add('hidden');
  cufG('cufClearActions').classList.remove('hidden');
}

function cufHandleClearEvent(frame) {
  if (frame.type === 'cancellable') {
    cufG('cufCancelClearBtn').disabled = false;
  } else if (frame.type === 'progress') {
    cufSetClearProgress(frame.current, frame.total);
  } else if (frame.type === 'done' || frame.type === 'error') {
    cufFinishClearStream();
    cufSetPickerInteractive(true);
    (async () => {
      // Refresh the picker FIRST (reflects whatever genuinely got cleared -- cleared mods drop their
      // flagged counts, matching the original blocking flow's own ordering), THEN render the result
      // summary on top of it, so the confirmation is what's actually left visible. Silent -- see
      // runClearUpdateFlagsList's own header comment for why a refresh failure here must never
      // compete with the result about to render right after.
      await runClearUpdateFlagsList({ silent: true });
      if (frame.type === 'done') {
        cufRenderResult(frame);
      } else {
        cufHandleError(new Error(frame.message || 'The clear failed.'));
      }
    })();
  }
}

cufG('cufClearBtn').addEventListener('click', async () => {
  const collectionModIds = [...document.querySelectorAll('#cufMain .cuf-row-check[data-kind="collection"]:checked')]
    .map((cb) => cb.dataset.collectionId);
  const includeStandalone = !!document.querySelector('#cufMain .cuf-row-check[data-kind="standalone"]:checked');
  if (collectionModIds.length === 0 && !includeStandalone) return;

  const btn = cufG('cufClearBtn');
  btn.disabled = true;
  cufG('cufCriticalError').classList.add('hidden');
  cufG('cufResult').classList.add('hidden');
  try {
    await cufApi('POST', '/api/clear-update-flags/clear', { collectionModIds, includeStandalone });
  } catch (e) {
    btn.disabled = false;
    cufHandleError(e);
    return;
  }

  // A real clear is now genuinely running server-side (the resolve+backup step already succeeded) --
  // only now switch to the progress view and start streaming it.
  cufSetPickerInteractive(false);
  cufG('cufClearActions').classList.add('hidden');
  const cancelBtn = cufG('cufCancelClearBtn');
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancel';
  cufSetClearProgress(0, 0);
  cufG('cufClearProgress').classList.remove('hidden');

  if (cufClearEventSource) cufClearEventSource.close();
  const es = new EventSource('/api/clear-update-flags/clear/events');
  cufClearEventSource = es;
  es.onmessage = (msg) => cufHandleClearEvent(JSON.parse(msg.data));
});

cufG('cufCancelClearBtn').addEventListener('click', async () => {
  const btn = cufG('cufCancelClearBtn');
  btn.textContent = 'Cancelling…';
  btn.disabled = true;
  try {
    await cufApi('POST', '/api/clear-update-flags/clear/cancel', {});
  } catch (e) {
    // Already finished or already gone -- the stream's own 'done' event resolves the UI either way.
  }
});
