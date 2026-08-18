'use strict';
// Update Collection v2 UI (Phase 1: read-only Check for Updates + Review, no real apply/deploy yet)
// -- talks only to /api/update-collection-v2/*. See design/vortex-update-collection-v2-mockup.html
// for the approved UI this mirrors and TECHNICAL.md's "Update Collection v2" section for the full
// design writeup. Own tiny api()/$ helpers, same reasoning as rules-generator-app.js's own
// (independent of app.js, safe to work on without touching already-validated code).

function $ucv2(id) { return document.getElementById(id); }

function escHtmlUcv2(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function ucv2Api(method, path, body) {
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

function ucv2ShowCriticalError(message) {
  const el = $ucv2('ucv2CriticalError');
  el.innerHTML = `<div class="callout__title">🛑 Couldn't do that</div><p>${escHtmlUcv2(message)}</p>`;
  el.classList.remove('hidden');
}
function ucv2HideCriticalError() {
  $ucv2('ucv2CriticalError').classList.add('hidden');
  $ucv2('ucv2CriticalError').innerHTML = '';
}

function ucv2HandleError(e, retryFn) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(retryFn || (() => {}));
    return;
  }
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(retryFn || (() => {}));
    return;
  }
  ucv2ShowCriticalError(e.message);
}

// ---- Screen navigation -- same "one visible section at a time" shape as the mockup's own goScreen,
// just against this app's real element ids. ----
const UCV2_SCREEN_IDS = ['ucv2Screen1', 'ucv2ScreenRemoved', 'ucv2Screen2'];
function ucv2GoScreen(id) {
  UCV2_SCREEN_IDS.forEach((s) => $ucv2(s).classList.toggle('hidden', s !== id));
  window.scrollTo(0, 0);
}

// Vortex itself only allows one collection update at a time -- mirrors the mockup's own
// activeReview lock exactly: every OTHER collection's "Review update" button disables while one's
// already in progress.
let ucv2ActiveReviewModId = null;
let ucv2Collections = []; // last-rendered list, from either /collections or /check-updates
let ucv2CurrentReview = null; // the in-progress review's own fetched {removed, updated, added, ...}
let ucv2RemovedChoice = null; // 'remove' | 'keep' -- informational only, nothing applies yet

function ucv2UpdateReviewLockUI() {
  document.querySelectorAll('.ucv2-review-btn').forEach((btn) => {
    const isActive = btn.dataset.modId === ucv2ActiveReviewModId;
    const locked = ucv2ActiveReviewModId !== null && !isActive;
    btn.disabled = locked;
    const note = btn.parentElement.querySelector('.review-lock-note');
    if (note) note.style.display = locked ? 'block' : 'none';
  });
}

// ---- Screen 1: Collections overview ----

function ucv2RenderCollections() {
  const grid = $ucv2('ucv2CollectionGrid');
  const empty = $ucv2('ucv2Empty');
  if (ucv2Collections.length === 0) {
    grid.innerHTML = '';
    empty.textContent = 'No installed collections found yet. Add one through Vortex first (Mods → Get More → Collections), then come back here.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = ucv2Collections.map((c) => {
    const checked = c.installedRevision !== undefined; // only present once /check-updates has run
    const badge = checked
      ? `<span class="ucv2-card__badge">Rev ${escHtmlUcv2(c.installedRevision ?? '?')}</span>`
      : '';
    const updateBadge = checked && c.updateAvailable
      ? `<span class="ucv2-card__update">↑ Update</span>` : '';
    const metaRight = checked
      ? (c.checkError ? `<span title="${escHtmlUcv2(c.checkError)}">couldn't check</span>`
        : c.updateAvailable ? `new: Rev ${escHtmlUcv2(c.newestRevisionNumber)}` : 'up to date')
      : 'click Check for Updates';
    const actionBtn = checked && c.updateAvailable
      ? `<button class="btn btn--primary btn--small ucv2-review-btn" data-mod-id="${escHtmlUcv2(c.modId)}" style="width:100%" onclick="ucv2StartReview('${escHtmlUcv2(c.modId)}')">Review update →</button>
         <p class="review-lock-note" style="display:none;font-size:11px;color:var(--text-muted);margin:6px 2px 0;text-align:center">Finish or cancel the update in progress first</p>`
      : `<button class="btn btn--small" style="width:100%" disabled>${checked ? (c.checkError ? "Couldn't check" : 'Up to date') : 'Not checked yet'}</button>`;
    return `<div class="ucv2-card">
      <div class="ucv2-card__image" style="background:linear-gradient(135deg,var(--surface-2),var(--bg))">
        ${c.pictureUrl ? `<img src="${escHtmlUcv2(c.pictureUrl)}" alt="">` : ''}
        <div class="ucv2-card__scrim"></div>
        ${badge}${updateBadge}
        <div class="ucv2-card__body">
          <div class="ucv2-card__title">${escHtmlUcv2(c.name)}</div>
          <div class="ucv2-card__author">by ${escHtmlUcv2(c.author || 'unknown')}</div>
          <div class="ucv2-card__meta"><span>${c.modCount} mods</span><span>${metaRight}</span></div>
        </div>
      </div>
      <div class="ucv2-card__actions">${actionBtn}</div>
    </div>`;
  }).join('');
  ucv2UpdateReviewLockUI();
}

async function ucv2LoadCollections() {
  ucv2HideCriticalError();
  $ucv2('ucv2Loading').classList.remove('hidden');
  try {
    const data = await ucv2Api('GET', '/api/update-collection-v2/collections');
    ucv2Collections = data.collections;
    ucv2RenderCollections();
  } catch (e) {
    ucv2HandleError(e, ucv2LoadCollections);
  } finally {
    $ucv2('ucv2Loading').classList.add('hidden');
  }
}
window.ucv2LoadCollections = ucv2LoadCollections;

async function ucv2CheckForUpdates() {
  ucv2HideCriticalError();
  const btn = $ucv2('ucv2CheckUpdatesBtn');
  btn.disabled = true;
  $ucv2('ucv2Loading').classList.remove('hidden');
  try {
    const data = await ucv2Api('POST', '/api/update-collection-v2/check-updates');
    ucv2Collections = data.collections;
    ucv2RenderCollections();
  } catch (e) {
    ucv2HandleError(e, ucv2CheckForUpdates);
  } finally {
    btn.disabled = false;
    $ucv2('ucv2Loading').classList.add('hidden');
  }
}
$ucv2('ucv2CheckUpdatesBtn').addEventListener('click', ucv2CheckForUpdates);

// ---- Review flow: Removed Mods decision (only when the diff actually has removed mods) -> Update
// Review table ----

function ucv2RevisionLabel() {
  const r = ucv2CurrentReview;
  return `Rev ${r.installedRevision ?? '?'} → Rev ${r.newRevisionNumber ?? '?'}`;
}

async function ucv2StartReview(modId) {
  if (ucv2ActiveReviewModId !== null) return; // button should already be disabled -- guard anyway
  ucv2ActiveReviewModId = modId;
  ucv2RemovedChoice = null;
  ucv2UpdateReviewLockUI();
  ucv2HideCriticalError();
  $ucv2('ucv2Loading').classList.remove('hidden');
  try {
    const review = await ucv2Api('POST', '/api/update-collection-v2/review', { collectionModId: modId });
    ucv2CurrentReview = review;
    if (review.removed.length > 0) {
      ucv2RenderRemovedScreen();
      ucv2GoScreen('ucv2ScreenRemoved');
    } else {
      ucv2RenderReviewScreen();
      ucv2GoScreen('ucv2Screen2');
    }
  } catch (e) {
    ucv2ActiveReviewModId = null;
    ucv2UpdateReviewLockUI();
    ucv2HandleError(e, () => ucv2StartReview(modId));
  } finally {
    $ucv2('ucv2Loading').classList.add('hidden');
  }
}
window.ucv2StartReview = ucv2StartReview;

function ucv2CancelReview() {
  ucv2ActiveReviewModId = null;
  ucv2CurrentReview = null;
  ucv2UpdateReviewLockUI();
  ucv2GoScreen('ucv2Screen1');
}
$ucv2('ucv2RemovedBackLink').addEventListener('click', (e) => { e.preventDefault(); ucv2CancelReview(); });
$ucv2('ucv2ReviewBackLink').addEventListener('click', (e) => { e.preventDefault(); ucv2CancelReview(); });
$ucv2('ucv2CancelReviewBtn').addEventListener('click', ucv2CancelReview);

function ucv2RenderRemovedScreen() {
  const r = ucv2CurrentReview;
  $ucv2('ucv2RemovedTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  const n = r.removed.length;
  $ucv2('ucv2RemovedLead').textContent = `The collection's author dropped ${n} mod${n === 1 ? '' : 's'} from this revision. Decide what would happen to ${n === 1 ? 'it' : 'them'} before continuing — same choice Vortex itself asks first, before anything else updates.`;
  $ucv2('ucv2RemovedList').innerHTML = r.removed.map((m) => `
    <div class="ucv2-op-row ucv2-op-row--remove">
      <div class="ucv2-op-row__name">${escHtmlUcv2(m.name)}</div>
      <div class="ucv2-op-row__detail">${m.version ? `v${escHtmlUcv2(m.version)} · ` : ''}${m.author ? `by ${escHtmlUcv2(m.author)} — ` : ''}no longer part of this revision</div>
    </div>`).join('');
}

function ucv2ChooseRemoved(choice) {
  ucv2RemovedChoice = choice;
  ucv2RenderReviewScreen();
  ucv2GoScreen('ucv2Screen2');
}
$ucv2('ucv2RemoveAllBtn').addEventListener('click', () => ucv2ChooseRemoved('remove'));
$ucv2('ucv2KeepAllBtn').addEventListener('click', () => ucv2ChooseRemoved('keep'));

function ucv2RowHtml(status, pillClass, name, versionText, author, instructions) {
  const instrBtn = instructions
    ? `<button class="ucv2-instr-btn" title="Has instructions" onclick="ucv2OpenInstructions(${JSON.stringify(name)}, ${JSON.stringify(instructions)})">ⓘ</button>`
    : '';
  return `<tr><td><span class="status-pill ${pillClass}">${status}</span></td><td>${escHtmlUcv2(name)}</td><td>${escHtmlUcv2(versionText)}</td><td>${escHtmlUcv2(author || '')}</td><td>${instrBtn}</td></tr>`;
}

function ucv2RenderReviewScreen() {
  const r = ucv2CurrentReview;
  $ucv2('ucv2ReviewTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  const totalChanged = r.updated.length + r.added.length + r.removed.length;
  $ucv2('ucv2ReviewLead').textContent = totalChanged === 0
    ? "This revision doesn't change this collection's mod list at all -- nothing to review."
    : `${r.updated.length + r.added.length} mod${(r.updated.length + r.added.length) === 1 ? '' : 's'} change in this update (the rest of the collection is untouched -- only what's actually changing is listed). Nothing happens to your files or Vortex's rules -- this preview doesn't apply anything yet.`;

  const recap = $ucv2('ucv2RemovedChoiceRecap');
  if (ucv2RemovedChoice) {
    const n = r.removed.length;
    recap.style.display = 'block';
    recap.innerHTML = ucv2RemovedChoice === 'remove'
      ? `<div class="callout__title">✕ Removed mods: would uninstall ${n === 1 ? 'it' : 'all ' + n}</div>This is a preview only -- nothing was actually removed.`
      : `<div class="callout__title">✕ Removed mods: would keep ${n === 1 ? 'it' : 'all ' + n}</div>This is a preview only -- nothing was actually changed.`;
  } else {
    recap.style.display = 'none';
  }

  const rows = [
    ...r.updated.map((u) => ucv2RowHtml('Update', 'status-pill--info', u.new.name, `v${u.old.version ?? '?'} → v${u.new.version ?? '?'}`, u.new.author, u.new.instructions)),
    ...r.added.map((m) => ucv2RowHtml('New', 'status-pill--success', m.name, `v${m.version ?? '?'}`, m.author, m.instructions)),
  ];
  $ucv2('ucv2ReviewTableBody').innerHTML = rows.join('');
  $ucv2('ucv2ReviewTableWrap').classList.toggle('hidden', rows.length === 0);
  $ucv2('ucv2ReviewEmpty').classList.toggle('hidden', rows.length > 0);
  if (rows.length === 0) $ucv2('ucv2ReviewEmpty').textContent = "Nothing to show here for this update.";
}

function ucv2OpenInstructions(title, body) {
  $ucv2('ucv2InstrModalTitle').textContent = title;
  $ucv2('ucv2InstrModalBody').textContent = body;
  $ucv2('ucv2InstrModal').classList.add('open');
}
window.ucv2OpenInstructions = ucv2OpenInstructions;
function ucv2CloseInstructions() { $ucv2('ucv2InstrModal').classList.remove('open'); }
$ucv2('ucv2InstrModalClose').addEventListener('click', ucv2CloseInstructions);
$ucv2('ucv2InstrModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) ucv2CloseInstructions(); });

// Deliberately NOT wired to any real deploy/write -- Phase 1 is review-only (see this file's own
// header comment and TECHNICAL.md). Shows a plain, honest "not built yet" message instead of
// silently no-op'ing or partially running something -- confirmed with the task's own explicit
// instruction not to half-wire this.
function ucv2ApplyUpdateClicked() {
  const recap = $ucv2('ucv2RemovedChoiceRecap');
  recap.style.display = 'block';
  recap.innerHTML = '<div class="callout__title">🛠️ Applying updates isn\'t built yet</div>This preview can check for updates and show you exactly what changed -- actually applying one (extraction, rules, deployment) is a later phase. Use Update Collection (Classic) for now.';
  window.scrollTo(0, 0);
}
$ucv2('ucv2ApplyUpdateBtn').addEventListener('click', ucv2ApplyUpdateClicked);

// Jumps to Update Collection (Classic) -- the callout's own inline link at the top of screen1.
const ucv2ClassicLink = $ucv2('ucv2ClassicLink');
if (ucv2ClassicLink) {
  ucv2ClassicLink.addEventListener('click', (e) => { e.preventDefault(); window.navigateToArea('sync'); });
}
