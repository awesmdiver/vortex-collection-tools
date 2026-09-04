'use strict';
// Safe Collection Removal ("The Quartermaster") -- front end. All real logic lives server-side in
// lib/remove-collection-runner.js; this file only renders what the API returns and echoes the
// user's own selections back on Apply. Reference mockup: design/vortex-remove-collection-mockup.html.

function $rc(id) { return document.getElementById(id); }
function escHtmlRc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function rcApi(method, path, body) {
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

function rcShowCriticalError(elId, message) {
  const el = $rc(elId);
  el.innerHTML = `<div class="callout__title">🛑 Couldn't do that</div><p>${escHtmlRc(message)}</p>`;
  el.classList.remove('hidden');
}
function rcHideCriticalError(elId) {
  $rc(elId).classList.add('hidden');
  $rc(elId).innerHTML = '';
}

// Same shared-modal error handling every other Vortex-gated tool in this app already uses
// (isServerUnreachableError/showServerUnreachableError/showVortexRunningModal/
// showHelperUnavailableModal -- defined in shell.js, loaded before this file).
function rcHandleError(e, elId, retryFn) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(retryFn || (() => {}));
    return;
  }
  if (e.status === 409 && e.body?.error === 'helper-unavailable') {
    window.showHelperUnavailableModal(retryFn || (() => {}));
    return;
  }
  rcShowCriticalError(elId, e.message);
}

let rcCollections = [];
let rcCurrentReview = null; // { collectionModId, collectionName, shared: [...], only: [...] }
let rcSelection = { shared: new Set(), only: new Set() }; // keys of the mods checked to remove

// ---- Stepper (2026-09-01) -- mirrored directly from Update Collection v2's own ucv2Steps/
// ucv2RenderStepper (web/public/update-collection-v2-app.js), not a second implementation. Fixed
// 3-pill list (no conditional steps the way Update Collection's Removed/Optional Installs pills are) --
// Review, the live removal progress, and the final result all fold into the "Remove" pill's own
// active state throughout, same reasoning ucv2ScreenStep's own header comment documents for Apply
// Progress + Apply Result staying pinned to "Apply" (no separate pill would otherwise get stuck
// reading "in progress" once the removal has actually finished, since there's no 4th step to mark it
// "done" relative to).
function rcSteps() { return ['Pick a collection', 'Review', 'Remove']; }
function rcRenderStepper(activeIdx) {
  const steps = rcSteps();
  $rc('rcStepper').innerHTML = steps.map((label, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    const num = i < activeIdx ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}
// rcScreen1 is visible by default (no "hidden" class in the markup) and nothing else calls
// rcGoScreen('rcScreen1') on a first visit -- same real gap ucv2RenderStepper(0)'s own header comment
// documents -- so step 1 needs its own explicit initial render here or it never shows as active until
// the user starts a review.
rcRenderStepper(0);
// True once rcRemoveCollection's own POST has actually started a real removal server-side (the
// "Remove" step, index 2) -- false while rcScreen2 is showing the Review sub-section (index 1). Reset
// on every fresh rcOpenReview so re-entering a review after a prior removal doesn't stay pinned at
// step 3. rcScreen2 itself hosts all three of Review/Progress/Result as sub-sections (no separate
// screen ids the way Update Collection v2 has for Apply Progress/Apply Result), so this flag is what
// actually distinguishes "Review" from "Remove" for the stepper -- the screen id alone can't.
let rcRemovalPhaseActive = false;

// ---- Screen 1: pick a collection ----

function rcRenderCollections() {
  const grid = $rc('rcCollectionGrid');
  const empty = $rc('rcEmpty');
  if (rcCollections.length === 0) {
    grid.innerHTML = '';
    empty.textContent = 'No installed collections found yet. Add one through Vortex first (Mods → Get More → Collections), then come back here.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = rcCollections.map((c) => {
    // Rev badge (2026-08-29, director's own direct ask) -- same "checked = /check-updates has run"
    // convention and markup as Update Collection v2's own ucv2RenderCollections badge, just against
    // this screen's own collections list.
    const badge = c.installedRevision !== undefined
      ? `<span class="ucv2-card__badge">Rev ${escHtmlRc(c.installedRevision ?? '?')}</span>`
      : '';
    return `<div class="ucv2-card">
    <div class="ucv2-card__image" style="background:linear-gradient(135deg,var(--surface-2),var(--bg))">
      ${c.pictureUrl ? `<img src="${escHtmlRc(c.pictureUrl)}" alt="">` : ''}
      <div class="ucv2-card__scrim"></div>
      ${badge}
      <div class="ucv2-card__body">
        <div class="ucv2-card__title">${escHtmlRc(c.name)}</div>
        <div class="ucv2-card__author">by ${escHtmlRc(c.author || 'unknown')}</div>
        <div class="ucv2-card__meta"><span>${c.modCount} mods</span></div>
      </div>
    </div>
    <div class="ucv2-card__actions">
      <button class="btn btn--danger btn--small" style="width:100%" onclick="rcOpenReview('${escHtmlRc(c.modId)}')">Remove collection</button>
    </div>
  </div>`;
  }).join('');
}

// Same server-side-cache polling pattern as Update Collection v2's own ucv2LoadCollections -- the
// collections grid (images/metadata) is populated automatically once at server startup; if this loads
// before that finishes (a real race right after the server starts), the response says so
// (`refreshing: true`) and this keeps the loading state up and polls again shortly, rather than
// showing a blank/stale grid.
let rcCollectionsPollTimer = null;
function rcStopCollectionsPolling() {
  if (rcCollectionsPollTimer) { clearTimeout(rcCollectionsPollTimer); rcCollectionsPollTimer = null; }
}

async function rcLoadCollections() {
  rcHideCriticalError('rcCriticalError');
  rcStopCollectionsPolling();
  $rc('rcLoading').classList.remove('hidden');
  try {
    const data = await rcApi('GET', '/api/remove-collection/collections');
    rcCollections = data.collections;
    rcRenderCollections();
    if (data.refreshing) {
      rcCollectionsPollTimer = setTimeout(rcLoadCollections, 2000);
    } else {
      $rc('rcLoading').classList.add('hidden');
    }
  } catch (e) {
    $rc('rcLoading').classList.add('hidden');
    rcHandleError(e, 'rcCriticalError', rcLoadCollections);
  }
}
window.rcLoadCollections = rcLoadCollections;

// Same "fires once each time arriving from a DIFFERENT area" reset pattern (2026-08-27,
// merge-entry-reset) -- resets rcCurrentReview and rcSelection back to their defaults, goes back to
// Screen 1, and re-loads the collections list fresh. Reuses rcCancelReview's own reset logic plus the
// collections reload it already does.
function rcResetOnEntry() {
  rcCancelReview();
}
window.rcResetOnEntry = rcResetOnEntry;

// ---- Screen 2: review shared mods, then remove ----

// .name-row (2026-09-01) -- the shared "Bordered name row" class DESIGN.md's own "Consolidating the
// checkbox-selection variants" section documents, replacing this tool's former .rc-mod-row. Mirrors
// design/vortex-bordered-row-mockup.html's own canonical markup exactly (label IS the row -- checkbox,
// name/meta block, spacer, trailing badge, all directly inside one clickable <label>), not the old
// div-wrapping-a-label shape. See that mockup's own file for why: DESIGN.md's original plan named
// TWO call sites to consolidate (.merge-chk-row alongside this one), but Merge Plugins' own Step 0
// collection picker had already independently migrated to the .coll-card/.picker-grid pattern by the
// time this was actually built -- .merge-chk-row was dead CSS with zero real call sites left, removed
// rather than "repointed." This is the one real, live consolidation.
function rcModRowHtml(m, group) {
  const checked = rcSelection[group].has(m.key);
  const badge = m.shared
    ? `<div class="spacer"></div><span class="badge badge--warning">required by ${m.usedBy.length} other${m.usedBy.length === 1 ? '' : 's'}</span>`
    : '';
  return `<label class="name-row${checked ? ' on' : ''}">
    <input type="checkbox" data-group="${group}" data-key="${escHtmlRc(m.key)}" ${checked ? 'checked' : ''}>
    <div>
      <div class="nm">${escHtmlRc(m.name)}</div>
      <div class="sub2">${escHtmlRc(m.version || '')}${m.shared ? ` &middot; also required by: ${escHtmlRc(m.usedBy.join(', '))}` : ''}</div>
    </div>
    ${badge}
  </label>`;
}

function rcUpdateCounts() {
  const r = rcCurrentReview;
  $rc('rcSharedCount').textContent = `${rcSelection.shared.size} of ${r.shared.length} selected to remove`;
  $rc('rcOnlyCount').textContent = `${rcSelection.only.size} of ${r.only.length} selected to remove`;
}

// Set a single checkbox's checked state, keep rcSelection and the row's ".on" accent
// (.name-row's own state class -- see design/vortex-bordered-row-mockup.html) in sync.
function rcSetRowChecked(cb, checked) {
  cb.checked = checked;
  const group = cb.dataset.group;
  if (checked) rcSelection[group].add(cb.dataset.key); else rcSelection[group].delete(cb.dataset.key);
  const row = cb.closest('.name-row');
  if (row) row.classList.toggle('on', checked);
}

// Per-group last-clicked checkbox, for shift-click range select (DESIGN.md's "Selectable lists"
// core pattern -- "click one, shift-click another, toggle everything between").
let rcLastClicked = { shared: null, only: null };

function rcWireCheckboxes() {
  document.querySelectorAll('#rcSharedList input[data-group], #rcOnlyList input[data-group]').forEach((cb) => {
    cb.addEventListener('click', (e) => {
      const group = cb.dataset.group;
      if (e.shiftKey && rcLastClicked[group]) {
        const all = Array.from(document.querySelectorAll(`input[data-group="${group}"]`));
        const from = all.indexOf(rcLastClicked[group]);
        const to = all.indexOf(cb);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          for (let i = lo; i <= hi; i += 1) rcSetRowChecked(all[i], cb.checked);
        }
      } else {
        rcSetRowChecked(cb, cb.checked);
      }
      rcLastClicked[group] = cb;
      rcUpdateCounts();
    });
  });
}

function rcRenderReviewScreen() {
  const r = rcCurrentReview;
  $rc('rcReviewTitle').textContent = `Remove "${r.collectionName}"?`;
  $rc('rcReviewLead').textContent = `This collection has ${r.modCount} mod${r.modCount === 1 ? '' : 's'}. `
    + `${r.shared.length} of ${r.shared.length === 1 ? 'it is' : 'them are'} required by another installed collection too -- review below before anything is removed.`;

  const hasShared = r.shared.length > 0;
  $rc('rcSharedWarning').classList.toggle('hidden', !hasShared);
  if (hasShared) {
    $rc('rcSharedWarningTitle').textContent = `⚠️ ${r.shared.length} of these mods ${r.shared.length === 1 ? 'is' : 'are'} required by multiple collections`;
  }
  $rc('rcSharedSection').classList.toggle('hidden', !hasShared);
  $rc('rcOnlySection').classList.toggle('hidden', r.only.length === 0);

  $rc('rcSharedList').innerHTML = r.shared.map((m) => rcModRowHtml(m, 'shared')).join('');
  $rc('rcOnlyList').innerHTML = r.only.map((m) => rcModRowHtml(m, 'only')).join('');
  rcWireCheckboxes();
  rcUpdateCounts();

  $rc('rcDeleteArchivesCheckbox').checked = false;
  $rc('rcApplyResult').classList.add('hidden');
  $rc('rcApplyResult').innerHTML = '';
  const removeBtn = $rc('rcRemoveBtn');
  removeBtn.classList.remove('hidden');
  removeBtn.disabled = false;
  removeBtn.textContent = 'Remove collection →';
  // "Back", not "Cancel" (2026-09-01, DESIGN.md's own decided rule: Cancel is only right when going
  // back is genuinely impossible -- nothing destructive has happened yet at this point, rcCancelReview
  // just returns to Screen 1, same shape Update Collection v2's own ucv2CancelReview already got
  // renamed for). rcRenderApplyResult below still correctly sets this to "Back to collections" once a
  // real removal has actually run.
  $rc('rcCancelBtn').textContent = 'Back';
}

async function rcOpenReview(modId) {
  rcRemovalPhaseActive = false;
  rcGoScreen('rcScreen2');
  rcHideCriticalError('rcCriticalError2');
  $rc('rcReviewBody').classList.add('hidden');
  $rc('rcLoading2').classList.remove('hidden');
  try {
    const review = await rcApi('POST', '/api/remove-collection/review', { collectionModId: modId });
    rcCurrentReview = review;
    // Only-required mods default checked (safe to remove); shared mods default UNCHECKED (kept safe)
    // -- the real gap this tool closes over Vortex's own flat "Remove mods" checkbox.
    rcSelection = { shared: new Set(), only: new Set(review.only.map((m) => m.key)) };
    rcRenderReviewScreen();
    $rc('rcReviewBody').classList.remove('hidden');
  } catch (e) {
    rcGoScreen('rcScreen1');
    rcHandleError(e, 'rcCriticalError', () => rcOpenReview(modId));
  } finally {
    $rc('rcLoading2').classList.add('hidden');
  }
}
window.rcOpenReview = rcOpenReview;

function rcGoScreen(id) {
  $rc('rcScreen1').classList.toggle('hidden', id !== 'rcScreen1');
  $rc('rcScreen2').classList.toggle('hidden', id !== 'rcScreen2');
  rcRenderStepper(id === 'rcScreen1' ? 0 : (rcRemovalPhaseActive ? 2 : 1));
  window.scrollTo(0, 0);
}

function rcWireSelectionBar(prefix, group) {
  $rc(`${prefix}SelectAll`).addEventListener('click', () => {
    document.querySelectorAll(`input[data-group="${group}"]`).forEach((cb) => rcSetRowChecked(cb, true));
    rcUpdateCounts();
  });
  $rc(`${prefix}Clear`).addEventListener('click', () => {
    document.querySelectorAll(`input[data-group="${group}"]`).forEach((cb) => rcSetRowChecked(cb, false));
    rcUpdateCounts();
  });
  $rc(`${prefix}Invert`).addEventListener('click', () => {
    document.querySelectorAll(`input[data-group="${group}"]`).forEach((cb) => rcSetRowChecked(cb, !cb.checked));
    rcUpdateCounts();
  });
}
rcWireSelectionBar('rcShared', 'shared');
rcWireSelectionBar('rcOnly', 'only');

function rcRenderApplyResult(result) {
  $rc('rcRemoveBtn').classList.add('hidden');
  $rc('rcCancelBtn').textContent = 'Back to collections';
  const allModsOk = result.modResults.every((r) => r.ok !== false);
  const allArchivesOk = (result.deletedArchiveResults || []).every((r) => r.ok !== false);
  const allOk = result.ok && allModsOk && allArchivesOk;

  let html = `<div class="callout${allOk ? ' callout--success' : ' callout--warning'}">`
    + `<div class="callout__title">${allOk ? `🎉 "${escHtmlRc(result.collectionName)}" removed` : '⚠️ Removed with some problems'}</div>`
    + (result.error ? `<p>${escHtmlRc(result.error)}</p>` : '')
    + `</div>`;
  if (result.modResults.length > 0) {
    html += `<p style="margin:14px 0 6px"><strong>Mods</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">`
      + result.modResults.map((r) => `<li>${r.ok === false ? '✗' : '✓'} ${escHtmlRc(r.name)}${r.error ? ` — ${escHtmlRc(r.error)}` : ''}</li>`).join('')
      + `</ul>`;
  }
  if ((result.deletedArchiveResults || []).length > 0) {
    html += `<p style="margin:14px 0 6px"><strong>Archives deleted</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">`
      + result.deletedArchiveResults.map((r) => `<li>${r.ok === false ? '✗' : '✓'} ${escHtmlRc(r.name)}${r.error ? ` — ${escHtmlRc(r.error)}` : ' — archive file deleted'}</li>`).join('')
      + `</ul>`;
  }
  const box = $rc('rcApplyResult');
  box.innerHTML = html;
  box.classList.remove('hidden');
}

// Real SSE-streamed progress (2026-08-25) -- POST /apply now only validates + starts the removal,
// then returns as soon as it's genuinely running server-side; GET /apply/events streams real phase
// updates (some with a per-item count, some phase-text-only -- see remove-collection-runner.js's own
// applyRemoval comment for why). Same consumption shape as Workshop Report's own
// wrHandleCheckEvent/EventSource pairing, reused rather than inventing a second one.
let rcApplyEventSource = null;

// Phase label copy, plain language, matches what's actually happening at each real step (DESIGN.md's
// "say what's actually happening in plain language" rule) -- falls back to the server's own message
// when a phase isn't one of these (forward-compatible, never shows a blank line).
function rcSetApplyProgress(frame) {
  const bar = $rc('rcApplyProgressBar');
  const text = $rc('rcApplyProgressText');
  if (frame.phase === 'deleting-archives' && frame.total) {
    bar.style.width = `${Math.round((frame.current / frame.total) * 100)}%`;
    text.textContent = `${frame.current} / ${frame.total} — Deleting archives…`;
  } else {
    // No real per-item count exists for 'resolving'/'removing' (a single atomic Helper call, no
    // progress possible from this side) -- an indeterminate-looking, mostly-full bar plus the real
    // status text is honest about that, same "Starting…" phase-only treatment Clear Update Flags
    // already uses before its own first per-mod event arrives.
    bar.style.width = '90%';
    text.textContent = frame.message || 'Working…';
  }
}

function rcFinishApplyStream() {
  if (rcApplyEventSource) { rcApplyEventSource.close(); rcApplyEventSource = null; }
  $rc('rcApplyProgress').classList.add('hidden');
}

function rcHandleApplyEvent(frame) {
  if (frame.type === 'phase') {
    rcSetApplyProgress(frame);
  } else if (frame.type === 'done') {
    rcFinishApplyStream();
    rcRenderApplyResult(frame);
    // A real removal happened (even a partial one) -- the collections grid may now be stale, so the
    // next visit to Screen 1 should reload rather than show a card for something already gone.
    rcCollections = [];
  } else if (frame.type === 'error') {
    rcFinishApplyStream();
    const btn = $rc('rcRemoveBtn');
    btn.disabled = false;
    btn.textContent = 'Remove collection →';
    rcHandleError(new Error(frame.message || 'The removal failed.'), 'rcCriticalError2', rcRemoveCollection);
  }
}

async function rcRemoveCollection() {
  const r = rcCurrentReview;
  const selectedModIds = [...rcSelection.shared, ...rcSelection.only];
  const btn = $rc('rcRemoveBtn');
  btn.disabled = true;
  btn.textContent = 'Removing…';
  rcHideCriticalError('rcCriticalError2');
  try {
    await rcApi('POST', '/api/remove-collection/apply', {
      collectionModId: r.collectionModId,
      selectedModIds,
      deleteArchives: $rc('rcDeleteArchivesCheckbox').checked,
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Remove collection →';
    rcHandleError(e, 'rcCriticalError2', rcRemoveCollection);
    return;
  }

  // A real removal is now genuinely running server-side -- only now switch to the progress view and
  // start streaming it. rcRemovalPhaseActive pins the stepper at index 2 ("Remove") from here through
  // both the live progress bar and the final result -- see that flag's own declaration comment.
  rcRemovalPhaseActive = true;
  rcRenderStepper(2);
  $rc('rcApplyProgressBar').style.width = '0%';
  $rc('rcApplyProgressText').textContent = 'Starting…';
  $rc('rcApplyProgress').classList.remove('hidden');

  if (rcApplyEventSource) rcApplyEventSource.close();
  const es = new EventSource('/api/remove-collection/apply/events');
  rcApplyEventSource = es;
  es.onmessage = (msg) => rcHandleApplyEvent(JSON.parse(msg.data));
}
$rc('rcRemoveBtn').addEventListener('click', rcRemoveCollection);

function rcCancelReview() {
  rcCurrentReview = null;
  rcRemovalPhaseActive = false;
  rcGoScreen('rcScreen1');
  if (rcCollections.length === 0) rcLoadCollections();
}
$rc('rcCancelBtn').addEventListener('click', rcCancelReview);
