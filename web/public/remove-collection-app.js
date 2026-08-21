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
  grid.innerHTML = rcCollections.map((c) => `<div class="ucv2-card">
    <div class="ucv2-card__image" style="background:linear-gradient(135deg,var(--surface-2),var(--bg))">
      ${c.pictureUrl ? `<img src="${escHtmlRc(c.pictureUrl)}" alt="">` : ''}
      <div class="ucv2-card__scrim"></div>
      <div class="ucv2-card__body">
        <div class="ucv2-card__title">${escHtmlRc(c.name)}</div>
        <div class="ucv2-card__author">by ${escHtmlRc(c.author || 'unknown')}</div>
        <div class="ucv2-card__meta"><span>${c.modCount} mods</span></div>
      </div>
    </div>
    <div class="ucv2-card__actions">
      <button class="btn btn--danger btn--small" style="width:100%" onclick="rcOpenReview('${escHtmlRc(c.modId)}')">Remove collection</button>
    </div>
  </div>`).join('');
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

// ---- Screen 2: review shared mods, then remove ----

function rcModRowHtml(m, group) {
  const checked = rcSelection[group].has(m.key);
  const tag = m.shared
    ? `<span class="rc-shared-tag">required by ${m.usedBy.length} other${m.usedBy.length === 1 ? '' : 's'}</span>`
    : '';
  return `<div class="rc-mod-row ${m.shared ? 'rc-mod-row--shared' : ''}${checked ? ' checked' : ''}">
    <label>
      <input type="checkbox" data-group="${group}" data-key="${escHtmlRc(m.key)}" ${checked ? 'checked' : ''}>
      <span>
        <div class="rc-mod-row__name">${escHtmlRc(m.name)}</div>
        <div class="rc-mod-row__meta">${escHtmlRc(m.version || '')}${m.shared ? ` &middot; also required by: ${escHtmlRc(m.usedBy.join(', '))}` : ''}</div>
      </span>
    </label>
    ${tag}
  </div>`;
}

function rcUpdateCounts() {
  const r = rcCurrentReview;
  $rc('rcSharedCount').textContent = `${rcSelection.shared.size} of ${r.shared.length} selected to remove`;
  $rc('rcOnlyCount').textContent = `${rcSelection.only.size} of ${r.only.length} selected to remove`;
}

// Set a single checkbox's checked state, keep rcSelection and the row's ".checked" accent
// (DESIGN.md's "Selectable lists" core pattern -- checked rows get a faint accent wash) in sync.
function rcSetRowChecked(cb, checked) {
  cb.checked = checked;
  const group = cb.dataset.group;
  if (checked) rcSelection[group].add(cb.dataset.key); else rcSelection[group].delete(cb.dataset.key);
  const row = cb.closest('.rc-mod-row');
  if (row) row.classList.toggle('checked', checked);
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
  $rc('rcCancelBtn').textContent = 'Cancel';
}

async function rcOpenReview(modId) {
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

  let html = `<div class="callout${allOk ? '' : ' callout--warning'}">`
    + `<div class="callout__title">${allOk ? `✓ &ldquo;${escHtmlRc(result.collectionName)}&rdquo; removed` : '⚠️ Removed with some problems'}</div>`
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

async function rcRemoveCollection() {
  const r = rcCurrentReview;
  const selectedModIds = [...rcSelection.shared, ...rcSelection.only];
  const btn = $rc('rcRemoveBtn');
  btn.disabled = true;
  btn.textContent = 'Removing…';
  rcHideCriticalError('rcCriticalError2');
  try {
    const result = await rcApi('POST', '/api/remove-collection/apply', {
      collectionModId: r.collectionModId,
      selectedModIds,
      deleteArchives: $rc('rcDeleteArchivesCheckbox').checked,
    });
    rcRenderApplyResult(result);
    // A real removal happened (even a partial one) -- the collections grid may now be stale, so the
    // next visit to Screen 1 should reload rather than show a card for something already gone.
    rcCollections = [];
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Remove collection →';
    rcHandleError(e, 'rcCriticalError2', rcRemoveCollection);
  }
}
$rc('rcRemoveBtn').addEventListener('click', rcRemoveCollection);

function rcCancelReview() {
  rcCurrentReview = null;
  rcGoScreen('rcScreen1');
  if (rcCollections.length === 0) rcLoadCollections();
}
$rc('rcCancelBtn').addEventListener('click', rcCancelReview);
$rc('rcBackLink').addEventListener('click', (e) => { e.preventDefault(); rcCancelReview(); });
