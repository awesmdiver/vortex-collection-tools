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
  // The Helper was reachable when this v2 flow started (Update Collection's own upfront check would
  // have routed to Classic otherwise) but died partway through -- Vortex closed, or the extension
  // crashed. Same shared-modal pattern as vortex-running, plus its own "Switch to Classic instead"
  // escape hatch (shell.js's showHelperUnavailableModal).
  if (e.status === 409 && e.body?.error === 'helper-unavailable') {
    window.showHelperUnavailableModal(retryFn || (() => {}));
    return;
  }
  ucv2ShowCriticalError(e.message);
}

// Small collection banner next to a review screen's own title -- matches the approved mockup's own
// .screen-head/.screen-head__thumb pattern (design/vortex-update-collection-v2-mockup.html), which
// this real build had dropped. No image for a genuinely uncached collection is a real, harmless
// case -- the thumb slot just stays hidden rather than showing a broken-image icon.
function ucv2SetScreenHeadThumb(imgId, pictureUrl) {
  const img = $ucv2(imgId);
  if (!img) return;
  if (pictureUrl) {
    img.src = pictureUrl;
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
  }
}

// ---- Stepper (2026-08-18) -- this app's own standard multi-step component (DESIGN.md's "Stepper --
// the standard for multi-step tools"), already used by Cycle Helper/Merge Plugins
// (.merge-stepper/.merge-step, cycle-helper-app.js's CH_STEPS/chRenderStepper) -- mirrored directly
// rather than inventing a second implementation. ucv2ScreenRemoved and ucv2Screen2 share step 1
// (Review) -- ucv2ScreenRemoved is only a conditional sub-screen of Review, shown when the revision
// actually drops mods, same "two screens, one step" precedent as Cycle Helper's own
// chScreenClean/chScreenCycles both mapping to its step 1. There's no separate screen for Apply
// (the real POST happens inline on ucv2Screen2, see ucv2ConfirmApply) -- ucv2RenderStepper(2) is
// called explicitly there, at the moment the real apply request actually goes out. ----
const UCV2_STEPS = ['Pick a collection', 'Review', 'Apply'];
function ucv2RenderStepper(activeIdx) {
  $ucv2('ucv2Stepper').innerHTML = UCV2_STEPS.map((label, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    const num = i < activeIdx ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}
// ucv2Screen1 is visible by default (no "hidden" class in the markup, unlike Cycle Helper's own
// chScreenPrep which chGoScreen('chScreenPrep') makes visible on DOMContentLoaded) -- nothing else
// ever calls ucv2GoScreen('ucv2Screen1') on a first visit, only ucv2CancelReview does once you've
// already left it, so the stepper needs its own explicit initial render here or step 1 never shows
// as active until the user starts a review.
ucv2RenderStepper(0);

// ---- Screen navigation -- same "one visible section at a time" shape as the mockup's own goScreen,
// just against this app's real element ids. ----
const UCV2_SCREEN_IDS = ['ucv2Screen1', 'ucv2ScreenRemoved', 'ucv2Screen2'];
const UCV2_SCREEN_STEP = { ucv2Screen1: 0, ucv2ScreenRemoved: 1, ucv2Screen2: 1 };
function ucv2GoScreen(id) {
  UCV2_SCREEN_IDS.forEach((s) => $ucv2(s).classList.toggle('hidden', s !== id));
  ucv2RenderStepper(UCV2_SCREEN_STEP[id]);
  window.scrollTo(0, 0);
}

// Vortex itself only allows one collection update at a time -- mirrors the mockup's own
// activeReview lock exactly: every OTHER collection's "Review update" button disables while one's
// already in progress.
let ucv2ActiveReviewModId = null;
let ucv2Collections = []; // last-rendered list, from either /collections or /check-updates
let ucv2CurrentReview = null; // the in-progress review's own fetched {removed, updated, added, ...}
let ucv2RemovedChoice = null; // 'remove' | 'keep' -- drives the real Apply's own removedChoice
let ucv2DeleteArchives = false; // only meaningful when ucv2RemovedChoice === 'remove'
let ucv2FomodPicks = {}; // modId (string) -> {[stepIdx]: {[groupIdx]: number[]}} -- resolved FOMOD picks, carried across re-apply calls the same way keepInstalledModIds is

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
      : 'click Refresh';
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

// Server-side auto-refresh (2026-08-18) -- the collections list (images, revisions, update
// availability) is now populated automatically ONCE, when the server process itself starts
// (director's own explicit model: "when you start Vortex it will do a collection refresh... let's
// do the same"). This just reads the server's own cache -- GET /collections never makes a Nexus call
// itself. If that startup refresh (or someone's manual Refresh) is still in flight when this loads
// (a real race if the page is opened quickly after the server starts), the response says so
// (`refreshing: true`) and this shows the SAME loading state the manual Refresh button already uses,
// then polls again shortly -- a real visible wait, never a silent one, per DESIGN.md's standing rule.
let ucv2CollectionsPollTimer = null;
function ucv2StopCollectionsPolling() {
  if (ucv2CollectionsPollTimer) { clearTimeout(ucv2CollectionsPollTimer); ucv2CollectionsPollTimer = null; }
}
async function ucv2LoadCollections() {
  ucv2HideCriticalError();
  ucv2StopCollectionsPolling();
  try {
    const data = await ucv2Api('GET', '/api/update-collection-v2/collections');
    ucv2Collections = data.collections;
    ucv2RenderCollections();
    if (data.refreshing) {
      $ucv2('ucv2Loading').classList.remove('hidden');
      ucv2CollectionsPollTimer = setTimeout(ucv2LoadCollections, 2000);
    } else {
      $ucv2('ucv2Loading').classList.add('hidden');
    }
  } catch (e) {
    $ucv2('ucv2Loading').classList.add('hidden');
    ucv2HandleError(e, ucv2LoadCollections);
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
  ucv2DeleteArchives = false;
  $ucv2('ucv2DeleteArchivesCheckbox').checked = false;
  ucv2FomodPicks = {};
  ucv2UpdateReviewLockUI();
  ucv2HideCriticalError();
  $ucv2('ucv2Loading').classList.remove('hidden');
  try {
    const review = await ucv2Api('POST', '/api/update-collection-v2/review', { collectionModId: modId });
    ucv2CurrentReview = review;
    // The review response has no image of its own -- reuse the collection's own cached pictureUrl
    // (populated by the Refresh cache, see update-collection-auto-check-for-images) rather than a
    // second fetch, since it's the exact same collection this review is for.
    ucv2CurrentReview.pictureUrl = ucv2Collections.find((c) => c.modId === modId)?.pictureUrl || null;
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
  // Reset Screen 2's own apply-result UI back to its pre-apply state, so the NEXT review (a
  // different collection, or this same one re-reviewed) never shows stale results from a previous
  // apply -- these are re-shown fresh by ucv2RenderReviewScreen/ucv2RenderApplyResult each time.
  $ucv2('ucv2ApplyResult').classList.add('hidden');
  $ucv2('ucv2ReviewActions').classList.remove('hidden');
  const applyBtn = $ucv2('ucv2ApplyUpdateBtn');
  applyBtn.disabled = false;
  applyBtn.textContent = 'Apply Update →';
  $ucv2('ucv2CancelReviewBtn').textContent = 'Cancel';
  ucv2GoScreen('ucv2Screen1');
  // A real apply may have changed what's installed -- always reload fresh rather than show a
  // possibly-stale pre-apply collections list.
  ucv2LoadCollections();
}
$ucv2('ucv2RemovedBackLink').addEventListener('click', (e) => { e.preventDefault(); ucv2CancelReview(); });
$ucv2('ucv2ReviewBackLink').addEventListener('click', (e) => { e.preventDefault(); ucv2CancelReview(); });
$ucv2('ucv2CancelReviewBtn').addEventListener('click', ucv2CancelReview);

function ucv2RenderRemovedScreen() {
  const r = ucv2CurrentReview;
  $ucv2('ucv2RemovedTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  ucv2SetScreenHeadThumb('ucv2RemovedThumb', r.pictureUrl);
  const n = r.removed.length;
  $ucv2('ucv2RemovedLead').textContent = `The collection's author dropped ${n} mod${n === 1 ? '' : 's'} from this revision. Decide what should happen to ${n === 1 ? 'it' : 'them'} before anything else updates.`;
  $ucv2('ucv2RemovedList').innerHTML = r.removed.map((m) => `
    <div class="ucv2-op-row ucv2-op-row--remove">
      <div class="ucv2-op-row__name">${escHtmlUcv2(m.name)}</div>
      <div class="ucv2-op-row__detail">${m.version ? `v${escHtmlUcv2(m.version)}` : ''}${m.version && m.author ? ' · ' : ''}${m.author ? `by ${escHtmlUcv2(m.author)}` : ''}</div>
    </div>`).join('');
}

function ucv2ChooseRemoved(choice) {
  ucv2RemovedChoice = choice;
  ucv2DeleteArchives = choice === 'remove' && $ucv2('ucv2DeleteArchivesCheckbox').checked;
  ucv2RenderReviewScreen();
  ucv2GoScreen('ucv2Screen2');
}
$ucv2('ucv2RemoveAllBtn').addEventListener('click', () => ucv2ChooseRemoved('remove'));
$ucv2('ucv2KeepAllBtn').addEventListener('click', () => ucv2ChooseRemoved('keep'));

function ucv2RowHtml(status, pillClass, name, versionText, keepCellHtml, author, instructions, rowClass) {
  // data-* attributes (properly HTML-escaped), not an inline onclick built from JSON.stringify --
  // real instructions text can contain a literal `"`, which breaks out of a double-quoted onclick
  // attribute early and corrupts the rest of the row's HTML (confirmed real: "Uncaught SyntaxError:
  // Unexpected end of input" clicking a real mod's Instructions icon). Read via the delegated click
  // listener below instead.
  const instrBtn = instructions
    ? `<button class="ucv2-instr-btn" title="Has instructions" data-ucv2-instr-name="${escHtmlUcv2(name)}" data-ucv2-instr-body="${escHtmlUcv2(instructions)}">ⓘ</button>`
    : '';
  // rowClass (2026-08-18) -- optional, only used by the collapsed Unchanged section below.
  const cls = rowClass ? ` class="${rowClass}"` : '';
  return `<tr${cls}><td><span class="status-pill ${pillClass}">${status}</span></td><td>${escHtmlUcv2(name)}</td><td>${escHtmlUcv2(versionText)}</td><td class="ucv2-keep-col">${keepCellHtml}</td><td>${escHtmlUcv2(author || '')}</td><td>${instrBtn}</td></tr>`;
}

// ---- Keep-installed-version choice (2026-08-18) -- "I already have Mod version 2.3.0 installed,
// and the collection replaced it 2.2.5 -- I want to keep the newer mod" (the director's own real
// case). Updated bucket only. Keyed by Nexus modId (u.old.source.modId), stable across the diff,
// same "hold a stable identity, not an array index, in client state" reasoning already used
// elsewhere in this app. Same Select All/Invert Selection/Clear Selection convention Archive
// Finder's own real selection bar already established (afSelectAllBtn etc., afState.selected). ----
let ucv2KeepInstalledModIds = new Set();

function ucv2UpdatedModId(u) {
  return String(u.old.source && u.old.source.modId);
}

function ucv2UpdateKeepCount() {
  const total = (ucv2CurrentReview?.updated || []).length;
  const n = ucv2KeepInstalledModIds.size;
  $ucv2('ucv2KeepCount').textContent = total ? `${n} of ${total} kept at installed version` : '';
}

function ucv2SyncKeepCheckboxes() {
  document.querySelectorAll('#ucv2ReviewTableBody input[data-ucv2-keep-modid]').forEach((cb) => {
    cb.checked = ucv2KeepInstalledModIds.has(cb.dataset.ucv2KeepModid);
  });
  ucv2UpdateKeepCount();
}

$ucv2('ucv2ReviewTableBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-ucv2-keep-modid]');
  if (!cb) return;
  if (cb.checked) ucv2KeepInstalledModIds.add(cb.dataset.ucv2KeepModid);
  else ucv2KeepInstalledModIds.delete(cb.dataset.ucv2KeepModid);
  ucv2UpdateKeepCount();
});
$ucv2('ucv2KeepSelectAllBtn').addEventListener('click', () => {
  (ucv2CurrentReview?.updated || []).forEach((u) => ucv2KeepInstalledModIds.add(ucv2UpdatedModId(u)));
  ucv2SyncKeepCheckboxes();
});
$ucv2('ucv2KeepInvertBtn').addEventListener('click', () => {
  (ucv2CurrentReview?.updated || []).forEach((u) => {
    const id = ucv2UpdatedModId(u);
    if (ucv2KeepInstalledModIds.has(id)) ucv2KeepInstalledModIds.delete(id);
    else ucv2KeepInstalledModIds.add(id);
  });
  ucv2SyncKeepCheckboxes();
});
$ucv2('ucv2KeepClearBtn').addEventListener('click', () => {
  ucv2KeepInstalledModIds.clear();
  ucv2SyncKeepCheckboxes();
});

function ucv2RenderReviewScreen() {
  const r = ucv2CurrentReview;
  $ucv2('ucv2ReviewTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  ucv2SetScreenHeadThumb('ucv2ReviewThumb', r.pictureUrl);
  const totalChanged = r.updated.length + r.added.length + r.removed.length;
  // installedTotal/installedChanged (2026-08-18) -- reconciles the lead line against the collection's
  // real CURRENTLY-INSTALLED mod count (a real confusion caught testing: a 25-mod collection only
  // ever showed the 4 that changed, with no trace of the other 21). Deliberately unchanged+updated+
  // removed only, NOT added -- an added mod isn't part of "the 26 mods you currently have" yet (it's
  // a new record this revision introduces, not installed automatically -- see the callout above), so
  // folding it into the same total would over-count against two different perspectives (what you
  // have vs. what the new revision offers) instead of reconciling against either one correctly.
  const installedTotal = r.unchanged.length + r.updated.length + r.removed.length;
  const installedChanged = r.updated.length + r.removed.length;
  const addedNote = r.added.length === 0 ? '' : `, and ${r.added.length} new mod${r.added.length === 1 ? '' : 's'} ${r.added.length === 1 ? 'is' : 'are'} being introduced`;
  $ucv2('ucv2ReviewLead').textContent = totalChanged === 0
    ? "This revision doesn't change this collection's mod list at all -- nothing to review."
    : installedTotal === 0
      ? `This revision adds ${r.added.length} new mod${r.added.length === 1 ? '' : 's'} to this collection. Review below, then click Apply Update when you're ready -- nothing happens to your files until then.`
      : installedChanged === 0
        ? `None of your ${installedTotal} currently-installed mods change in this update${addedNote} -- they'll stay exactly as they are. Review below, then click Apply Update when you're ready -- nothing happens to your files until then.`
        : `${installedChanged} of your ${installedTotal} currently-installed mods ${installedChanged === 1 ? 'is' : 'are'} changing in this update${addedNote} -- the rest stay exactly as they are. Review what's changing below, then click Apply Update when you're ready -- nothing happens to your files until then.`;

  // Pre-check "keep installed version" for a mod whose live install is genuinely newer than this
  // revision's own pin -- a real, deliberate default the director asked for; see
  // isInstalledVersionNewer's own header comment (server-side) for why it's conservative.
  ucv2KeepInstalledModIds = new Set(r.updated.filter((u) => u.installedIsNewer).map(ucv2UpdatedModId));

  const rows = [
    ...r.updated.map((u) => {
      // A choices-only change (u.fileChanged === false) is the exact same file, just different FOMOD
      // picks -- showing "v1.1 -> v1.1" reads as a bug, not a real update, so label it by what
      // actually changed instead. "Keep installed version" doesn't apply either: that choice is about
      // which FILE stays installed, and there's only one file here.
      if (u.fileChanged === false) {
        return ucv2RowHtml('Update', 'status-pill--info', u.new.name, 'FOMOD', '', u.new.author, u.new.instructions);
      }
      const modId = ucv2UpdatedModId(u);
      const note = u.installedIsNewer ? '<br><span class="muted" style="font-size:12px">You have a newer version installed than this collection uses</span>' : '';
      // Real live version (server-resolved via the Helper, cross-referenced against Vortex's actual
      // current mod state) wins over the collection's own stale old-revision recording whenever it
      // differs -- so a mod updated outside this collection's tracking shows what's really about to
      // happen (your real version -> the new revision's version), not a backwards-reading arrow built
      // from a pin that's no longer true. Falls back to the collection's own recording when the Helper
      // couldn't resolve this mod live (unreachable, or a genuinely new/ambiguous case).
      const fromVersion = u.liveInstalledVersion ?? u.old.version;
      const keepTooltip = 'This collection update includes an older version of this mod than you currently have. Check "Keep installed" to skip the downgrade and keep your current version.';
      const keepCell = `<label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer" title="${escHtmlUcv2(keepTooltip)}"><input type="checkbox" data-ucv2-keep-modid="${escHtmlUcv2(modId)}" ${u.installedIsNewer ? 'checked' : ''}><span>Keep installed${note}</span></label>`;
      return ucv2RowHtml('Update', 'status-pill--info', u.new.name, `v${fromVersion ?? '?'} → v${u.new.version ?? '?'}`, keepCell, u.new.author, u.new.instructions);
    }),
    ...r.added.map((m) => ucv2RowHtml('New', 'status-pill--success', m.name, `v${m.version ?? '?'}`, '', m.author, m.instructions)),
    // Removed/Kept (2026-08-18) -- the collection author dropped these; ucv2RemovedChoice (set on
    // the earlier Removed-decision screen, always non-null by the time any removed mod exists here
    // -- see ucv2StartReview) is a single all-or-nothing choice, so every removed mod gets the same
    // pill. Neither "Keep installed?" (that's a different concept -- see ucv2KeepInstalledModIds
    // above, Updated rows only) nor "Instructions" (nothing is being installed) applies here, so
    // both cells are left empty, same convention Added rows already use for the keep cell.
    ...r.removed.map((m) => (ucv2RemovedChoice === 'remove'
      ? ucv2RowHtml('Remove', 'status-pill--critical', m.name, m.version ? `v${m.version}` : '', '', m.author, undefined)
      : ucv2RowHtml('Keep', 'status-pill--neutral', m.name, m.version ? `v${m.version}` : '', '', m.author, undefined))),
  ];
  // Unchanged (2026-08-18) -- listed too now, but collapsed behind a toggle by default (same
  // collapsed-by-default idea as this app's other "lowest-priority content" lists, e.g.
  // .chip-list-details/.sync-list-toggle), since these mods need no action from you and a 25-mod
  // collection with 20 unchanged would otherwise bury the rows that actually matter under a wall of
  // "Installed" pills. Real rows in the SAME table (not a separate list) so the total row count still
  // reconciles against the collection's real mod count once expanded.
  const unchangedRows = r.unchanged.length === 0 ? [] : [
    `<tr class="ucv2-unchanged-toggle-row"><td colspan="6"><a class="sync-list-toggle" `
      + `data-more="▾ Show ${r.unchanged.length} unchanged mod${r.unchanged.length === 1 ? '' : 's'} (already installed)" `
      + `data-less="▴ Hide unchanged mods">▾ Show ${r.unchanged.length} unchanged `
      + `mod${r.unchanged.length === 1 ? '' : 's'} (already installed)</a></td></tr>`,
    ...r.unchanged.map((m) => ucv2RowHtml('Installed', 'status-pill--neutral', m.name, m.version ? `v${m.version}` : '', '', m.author, m.instructions, 'ucv2-unchanged-row hidden')),
  ];
  $ucv2('ucv2ReviewTableBody').innerHTML = [...rows, ...unchangedRows].join('');
  // "Keep installed?" only ever applies to Updated rows -- an Added-only review (no updates at all)
  // has nothing to put in that column, so hide it rather than showing a dead, empty header.
  document.querySelectorAll('#ucv2ReviewTableWrap .ucv2-keep-col')
    .forEach((el) => el.classList.toggle('hidden', r.updated.length === 0));
  const anyRows = rows.length > 0 || r.unchanged.length > 0;
  $ucv2('ucv2ReviewTableWrap').classList.toggle('hidden', !anyRows);
  $ucv2('ucv2ReviewEmpty').classList.toggle('hidden', anyRows);
  if (!anyRows) $ucv2('ucv2ReviewEmpty').textContent = "Nothing to show here for this update.";
  $ucv2('ucv2KeepSelectionBar').classList.toggle('hidden', r.updated.length === 0);
  ucv2UpdateKeepCount();
}
// Same "+N more / Show less" mechanism as sync-app.js's own handleSyncListToggleClick, adapted to
// table rows instead of .chip-row/.chip -- there's no separate list here, the unchanged mods are
// real rows in this SAME table, just hidden until expanded.
$ucv2('ucv2ReviewTableBody').addEventListener('click', (e) => {
  const toggle = e.target.closest('.sync-list-toggle');
  if (!toggle) return;
  const extras = document.querySelectorAll('#ucv2ReviewTableBody .ucv2-unchanged-row');
  const collapsed = extras.length > 0 && extras[0].classList.contains('hidden');
  extras.forEach((row) => row.classList.toggle('hidden', !collapsed));
  toggle.textContent = collapsed ? toggle.dataset.less : toggle.dataset.more;
});

function ucv2OpenInstructions(title, body) {
  $ucv2('ucv2InstrModalTitle').textContent = title;
  $ucv2('ucv2InstrModalBody').textContent = body;
  $ucv2('ucv2InstrModal').classList.add('open');
}
// Delegated -- rows are re-rendered wholesale via innerHTML on every review, so a per-button listener
// would need re-attaching every time; one listener on the table body covers every row, present or future.
$ucv2('ucv2ReviewTableBody').addEventListener('click', (e) => {
  const btn = e.target.closest('.ucv2-instr-btn');
  if (btn) ucv2OpenInstructions(btn.dataset.ucv2InstrName, btn.dataset.ucv2InstrBody);
});
function ucv2CloseInstructions() { $ucv2('ucv2InstrModal').classList.remove('open'); }
$ucv2('ucv2InstrModalClose').addEventListener('click', ucv2CloseInstructions);
$ucv2('ucv2InstrModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) ucv2CloseInstructions(); });

// ---- Phase 2 (2026-08-18): real Apply for the Updated and Removed buckets only -- see
// TECHNICAL.md's "Update Collection v2 Phase 2" section. Added mods are explicitly out of scope
// (Phase 3) -- their row in the review table gets a "not applied this phase" note, never a real
// outcome. No live progress streaming (a real synchronous /apply call, not SSE) -- a deliberate
// scope trade-off, flagged in TECHNICAL.md rather than silently built as if it were full Screen 3
// live progress; results render in place once the single request completes. ----

function ucv2ApplyUpdateClicked() {
  const r = ucv2CurrentReview;
  const modal = $ucv2('ucv2ApplyConfirmModal');
  const body = $ucv2('ucv2ApplyConfirmBody');
  const removedNote = r.removed.length === 0 ? ''
    : ucv2RemovedChoice === 'remove'
      ? `<li><strong>${r.removed.length}</strong> removed mod${r.removed.length === 1 ? '' : 's'} will be fully uninstalled from Vortex.</li>`
      : `<li><strong>${r.removed.length}</strong> removed mod${r.removed.length === 1 ? '' : 's'} will be left installed, just no longer tracked as part of this collection.</li>`;
  const addedNote = r.added.length === 0 ? ''
    : `<li><strong>${r.added.length}</strong> new mod${r.added.length === 1 ? '' : 's'} will be extracted, installed, and deployed into Vortex.</li>`;
  const keptCount = ucv2KeepInstalledModIds.size;
  const toUpdateCount = r.updated.length - keptCount;
  const keepNote = keptCount === 0 ? ''
    : `<li><strong>${keptCount}</strong> mod${keptCount === 1 ? '' : 's'} will be left exactly as installed, not updated -- your own "keep installed version" choice.</li>`;
  // "No surprises" callout, same bar Mod Scrub's own delete confirmation sets -- a real, hard-to-
  // reverse disk delete gets its own clearly-marked block with the exact file list, not a line
  // buried in the general summary above.
  const archiveDeleteBlock = (ucv2DeleteArchives && r.removed.length > 0)
    ? `<div class="callout callout--warning" style="margin:14px 0"><div class="callout__title">⚠️ ${r.removed.length} archive${r.removed.length === 1 ? '' : 's'} will be permanently deleted from disk</div>`
      + `<ul style="margin:6px 0 0;padding-left:20px">${r.removed.map((m) => `<li>${escHtmlUcv2(m.name)}</li>`).join('')}</ul></div>`
    : '';
  // "External Changes" dialog heads-up (2026-08-18) -- a real, repeatedly-confirmed Vortex behavior,
  // not a bug: this tool writes new mods' files directly to disk (bypassing InstallManager, same as
  // every real write here), so Vortex's own file-watcher genuinely has no prior record for them and
  // surfaces its real "External Changes" dialog during the deploy that follows. Traced this all the
  // way to Vortex's own real source (classifyExternalChange, mod_management/util/externalChanges.ts):
  // a genuine Vortex-driven collection install suppresses this automatically via
  // InstallManager.markRecentInstall(), but that method has no public context.api.ext surface -- there
  // is no way to trigger the same suppression from outside Vortex's own process without patching
  // Vortex itself, which this project doesn't do. Since the dialog can't be prevented, the honest
  // next-best fix is telling the user what to expect and that the answer is always safe, rather than
  // leaving it as an unexplained interruption -- only shown when this apply actually installs new
  // mods, since that's the only real case that triggers it (confirmed live, repeatedly).
  const externalChangesNote = r.added.length === 0 ? '' : `<div class="callout callout--warning" style="margin:14px 0">`
    + `<div class="callout__title">⚠️ Vortex may ask about "External Changes"</div>`
    + `Installing new mods can make Vortex show its own "External Changes" dialog partway through -- `
    + `that's expected, not a problem. It happens because this tool writes new mod files directly, so `
    + `Vortex notices content it has no prior record for. Choose <strong>Use newer file</strong> `
    + `(already the dialog's own default) and continue -- the newly-installed content is exactly what `
    + `should win.</div>`;
  body.innerHTML = `<p>A real backup will be taken first. Then:</p><ul style="margin:0;padding-left:20px">`
    + `<li><strong>${toUpdateCount}</strong> mod${toUpdateCount === 1 ? '' : 's'} will be re-extracted to the new version and redeployed into your Data folder.</li>`
    + keepNote + removedNote + addedNote
    + `</ul>` + archiveDeleteBlock + externalChangesNote
    + `<p style="margin-bottom:0">This writes real files. Vortex must stay open (via the helper extension) for this to work.</p>`;
  modal.classList.add('open');
}
$ucv2('ucv2ApplyUpdateBtn').addEventListener('click', ucv2ApplyUpdateClicked);
$ucv2('ucv2ApplyConfirmClose').addEventListener('click', () => $ucv2('ucv2ApplyConfirmModal').classList.remove('open'));
$ucv2('ucv2ApplyConfirmCancel').addEventListener('click', () => $ucv2('ucv2ApplyConfirmModal').classList.remove('open'));

// Plain-language rendering of a rule's raw versionMatch constraint (a real semver-range-style
// string, e.g. ">=1.0.0", "1.1.0", "*") -- per the plain-language-writer skill, shown as prose
// rather than the raw constraint whenever a common shape is recognized; falls back to showing the
// raw string for anything less common rather than guessing at a paraphrase that could be wrong.
function ucv2FormatVersionMatch(vm) {
  const clean = (vm || '').split('+')[0].trim();
  if (!clean || clean === '*') return 'any version';
  if (/^\d/.test(clean)) return `version ${clean} exactly`;
  const ge = clean.match(/^>=\s*([\d.]+)$/);
  if (ge) return `version ${ge[1]} or newer`;
  const gt = clean.match(/^>\s*([\d.]+)$/);
  if (gt) return `a version newer than ${gt[1]}`;
  const range = clean.match(/^>=\s*([\d.]+)\s*<\s*([\d.]+)$/);
  if (range) return `a version from ${range[1]} up to (but not including) ${range[2]}`;
  return `a version matching "${clean}"`;
}

function ucv2DependencyBreakRow(b) {
  return `<li style="margin-bottom:10px"><strong>${escHtmlUcv2(b.dependentName)}</strong> requires <strong>${escHtmlUcv2(b.updatedModName)}</strong> to be `
    + `${ucv2FormatVersionMatch(b.versionMatch)} — this update changes it from version ${escHtmlUcv2(b.oldVersion || '?')} to `
    + `<strong>${escHtmlUcv2(b.newVersion || '?')}</strong>, which won't satisfy that.</li>`;
}

let ucv2PendingDependencyBreaks = [];

function ucv2ShowDependencyBreakModal(breaks) {
  ucv2PendingDependencyBreaks = breaks;
  const body = $ucv2('ucv2DependencyBreakBody');
  body.innerHTML = `<p>${breaks.length} mod${breaks.length === 1 ? '' : 's'} depend${breaks.length === 1 ? 's' : ''} on something this update changes in a way that breaks the dependency:</p>`
    + `<ul style="margin:0;padding-left:20px;font-size:13px">${breaks.map(ucv2DependencyBreakRow).join('')}</ul>`
    + `<p style="margin-bottom:0">If you continue with <strong>Ignore</strong>, we'll mark these dependency rules as acknowledged so you don't keep getting warned about them — Vortex does the same thing when you choose Ignore. Or choose <strong>Keep My Installed Version</strong> to leave the mod${breaks.length === 1 ? '' : 's'} causing this exactly as installed instead, avoiding the break entirely.</p>`;
  $ucv2('ucv2DependencyBreakModal').classList.add('open');
}
$ucv2('ucv2DependencyBreakClose').addEventListener('click', () => $ucv2('ucv2DependencyBreakModal').classList.remove('open'));
$ucv2('ucv2DependencyBreakCancel').addEventListener('click', () => {
  $ucv2('ucv2DependencyBreakModal').classList.remove('open');
  const applyBtn = $ucv2('ucv2ApplyUpdateBtn');
  applyBtn.disabled = false;
  applyBtn.textContent = 'Apply Update →';
});
// Resolves each break's `updatedIndex` (the review's own Updated-bucket array position) back to the
// mod's real Nexus modId, using ucv2CurrentReview -- the same source of truth the server itself
// re-derives from, not a client-only guess. Adds each to the SAME keep-installed Set the Review
// screen's own checkboxes read/write, so the two entry points share one state, not two.
$ucv2('ucv2DependencyBreakKeepInstalled').addEventListener('click', () => {
  ucv2PendingDependencyBreaks.forEach((b) => {
    const u = ucv2CurrentReview?.updated?.[b.updatedIndex];
    if (u) ucv2KeepInstalledModIds.add(ucv2UpdatedModId(u));
  });
  ucv2SyncKeepCheckboxes();
  $ucv2('ucv2DependencyBreakModal').classList.remove('open');
  ucv2ConfirmApply();
});
$ucv2('ucv2DependencyBreakIgnore').addEventListener('click', () => {
  $ucv2('ucv2DependencyBreakModal').classList.remove('open');
  ucv2ConfirmApply({ ignoreDependencyBreaks: true });
});

// ---- FOMOD picker (2026-08-18, rebuilt same day) -- a real interactive step, deliberately
// reusable (Phase 3's own Added-mod FOMOD needs can drive this same component later). Paginates
// one real <installStep> at a time (left column: that step's own groups; right column: a fixed,
// independently-scrolling image+description panel on hover), matching Vortex's own real FOMOD
// wizard -- built directly against the approved
// design/vortex-update-collection-v2-fomod-picker-mockup.html, confirmed current against real
// Vortex source (installer_fomod_shared/views/InstallerDialog.tsx + dialog-fomod.scss). Renders
// the real install-step/group/plugin tree (fomod-parser.js's own parsed structure, now carrying
// visible/description/image/typeDescriptor too) for whichever mods need a fresh real choice:
// "open" (no recorded choices at all) or "mismatch" (recorded choices no longer cleanly map to the
// new revision's own ModuleConfig.xml). Steps through multiple mods one at a time -- a real patch
// hub can have a dozen groups and 100+ plugins, so stacking several such mods in one modal would be
// unusable -- and accumulates picks into the SAME ucv2FomodPicks object every apply call sends.
//
// This project has no live native engine to ask a real answer from (unlike real Vortex, which asks
// its own C# fomod-installer process after every selection) -- so step visibility and each
// plugin's real type (Required/Optional/Recommended/NotUsable/CouldBeUsable, both the static
// <type> form and the condition-pattern <dependencyType> form) are re-derived HERE, client-side,
// from the condition flags set by whatever the user has already picked in earlier steps/groups --
// confirmed against the real engine's own evaluation order (Nexus-Mods/fomod-installer,
// ConditionalOptionTypeResolver.ResolveOptionType: first matching pattern wins, else the default
// type). "(Preset)" is genuinely NOT tied to a plugin's own "Recommended" type (an initial wrong
// assumption, corrected by reading the real engine's XmlScriptExecutor.cs) -- it only ever marks an
// option that matches a SUPPLIED prior choice by name, which for this project means the
// "mismatch" case's own `existingChoices` (the collection's own recorded-but-no-longer-cleanly-
// replayable picks). "open" mods never get preset marks, matching real Vortex exactly (nothing
// supplied there either). Real images aren't fetched/rendered here (this project has no live
// archive-image-serving path, and the approved mockup itself only shows a bracketed placeholder,
// not a real image) -- the panel shows the real relative image PATH from the archive as text.
let ucv2FomodPickerNeeds = [];
let ucv2FomodPickerIndex = 0;
let ucv2FomodPickerOnDone = null;
let ucv2FomodPickerStepIdx = 0;
let ucv2FomodPickerAnswers = {}; // {[stepIdx]: {[groupIdx]: number[]}} -- this mod's own picks so far
let ucv2FomodPickerInitedSteps = new Set(); // `${modIndex}:${stepIdx}` -- Required/preset auto-pick runs once per step, not every render
let ucv2FomodPickerPrevStepIdx = -1;
let ucv2FomodPickerNextStepIdx = -1;

function ucv2ShowFomodPicker(needs, onDone) {
  ucv2FomodPickerNeeds = needs;
  ucv2FomodPickerIndex = 0;
  ucv2FomodPickerStepIdx = 0;
  ucv2FomodPickerAnswers = {};
  ucv2FomodPickerInitedSteps = new Set();
  ucv2FomodPickerOnDone = onDone;
  $ucv2('ucv2FomodPickerModal').classList.add('open');
  ucv2FomodRenderStep();
}

function ucv2FomodGroupInputName(stepIdx, groupIdx) {
  return `ucv2fomod-s${stepIdx}-g${groupIdx}`;
}

// A composite condition (an installStep's <visible>, or a typeDescriptor pattern's <dependencies>)
// -- {operator: 'And'|'Or', flagDependencies: [{flag, value}]}. No dependencies at all (a bare
// self-closing tag, or absent entirely) is vacuously true -- confirmed against a real archive
// ("Window Shadows Ultimate - Patch Hub") whose own <visible operator="And"></visible> blocks have
// zero children, meaning "always visible".
function ucv2FomodEvalCondition(cond, flags) {
  if (!cond) return true;
  const deps = cond.flagDependencies || [];
  if (deps.length === 0) return true;
  const test = (d) => (flags.get(d.flag) ?? '') === d.value;
  return cond.operator === 'Or' ? deps.some(test) : deps.every(test);
}

// First matching pattern wins; falls back to the default type if none match -- exact real engine
// order (ConditionalOptionTypeResolver.ResolveOptionType).
function ucv2FomodResolveType(typeDescriptor, flags) {
  if (!typeDescriptor) return 'Optional';
  for (const p of typeDescriptor.patterns || []) {
    if (ucv2FomodEvalCondition(p.condition, flags)) return p.type;
  }
  return typeDescriptor.default || 'Optional';
}

function ucv2FomodAddGroupFlags(flags, group, selectedIndices) {
  const selected = group.type === 'SelectAll'
    ? group.plugins.map((_, idx) => idx)
    : (selectedIndices || []);
  selected.forEach((idx) => {
    const plugin = group.plugins[idx];
    if (!plugin) return;
    (plugin.conditionFlags || []).forEach((f) => flags.set(f.name, f.value));
  });
}

// Condition flags contributed by every group answered so far, STRICTLY BEFORE (stepIdx, groupIdx)
// in document order -- every group of every earlier step, plus (when groupIdx is given) the
// earlier groups of stepIdx itself. Rebuilt from scratch on every call (not cached) so going back
// and changing an earlier answer correctly un-sets whatever flags that old pick had contributed --
// mirrors choice-resolver.js's own flags-building, just done incrementally at pick-time instead of
// after the fact. Pass groupIdx=undefined to get flags for the WHOLE of stepIdx (step-visibility
// checks, which only care about steps strictly before stepIdx).
function ucv2FomodFlagsUpTo(need, answers, stepIdx, groupIdx) {
  const flags = new Map();
  const steps = need.parsedFomod.installSteps;
  for (let s = 0; s < stepIdx && s < steps.length; s++) {
    const stepAnswers = answers[s] || {};
    steps[s].groups.forEach((group, gi) => ucv2FomodAddGroupFlags(flags, group, stepAnswers[gi]));
  }
  if (groupIdx !== undefined && steps[stepIdx]) {
    const stepAnswers = answers[stepIdx] || {};
    for (let g = 0; g < groupIdx; g++) ucv2FomodAddGroupFlags(flags, steps[stepIdx].groups[g], stepAnswers[g]);
  }
  return flags;
}

// Visibility for every step, index-aligned -- each entry evaluated against flags from every step
// strictly before it (a step's own answers can't affect its own visibility).
function ucv2FomodComputeStepVisibility(need, answers) {
  const steps = need.parsedFomod.installSteps;
  return steps.map((step, i) => ucv2FomodEvalCondition(step.visible, ucv2FomodFlagsUpTo(need, answers, i)));
}

// The "mismatch" case's own existingChoices (the collection's own recorded-but-stale picks) --
// matched by GROUP NAME (trimmed), same convention choice-resolver.js's resolveChoices() already
// uses for its own recorded-choices matching. Returns the set of plugin NAMES (trimmed) that were
// previously chosen for this exact step+group -- empty for "open" (need.existingChoices absent) or
// any step/group with no corresponding recorded entry.
function ucv2FomodPresetNames(need, stepIdx, groupIdx) {
  if (!need.existingChoices || !need.existingChoices.options) return new Set();
  const recordedStep = need.existingChoices.options[stepIdx];
  if (!recordedStep) return new Set();
  const step = need.parsedFomod.installSteps[stepIdx];
  const groupNameTrimmed = (step.groups[groupIdx].name || '').trim();
  const recordedGroup = (recordedStep.groups || []).find((g) => (g.name || '').trim() === groupNameTrimmed);
  if (!recordedGroup) return new Set();
  return new Set((recordedGroup.choices || []).map((c) => (c.name || '').trim()));
}

// Auto-picks Required-type plugins (can't be deselected, matches the real engine's own
// `readOnly = plugin.type === 'Required'`) and, for the "mismatch" case only, whatever matches a
// recorded preset choice by name -- runs exactly ONCE per (mod, step) so revisiting a step via
// Back/Next never clobbers the user's own subsequent edits.
function ucv2FomodInitStepAnswersOnce(need, stepIdx) {
  const key = `${ucv2FomodPickerIndex}:${stepIdx}`;
  if (ucv2FomodPickerInitedSteps.has(key)) return;
  ucv2FomodPickerInitedSteps.add(key);
  const step = need.parsedFomod.installSteps[stepIdx];
  ucv2FomodPickerAnswers[stepIdx] = ucv2FomodPickerAnswers[stepIdx] || {};
  step.groups.forEach((group, groupIdx) => {
    if (group.type === 'SelectAll') return; // nothing to init -- server auto-includes these regardless
    const flags = ucv2FomodFlagsUpTo(need, ucv2FomodPickerAnswers, stepIdx, groupIdx);
    const presetNames = ucv2FomodPresetNames(need, stepIdx, groupIdx);
    const forced = [];
    group.plugins.forEach((plugin, idx) => {
      const type = ucv2FomodResolveType(plugin.typeDescriptor, flags);
      if (type === 'Required' || presetNames.has((plugin.name || '').trim())) forced.push(idx);
    });
    const isRadio = group.type === 'SelectExactlyOne' || group.type === 'SelectAtMostOne';
    if (forced.length > 0) {
      ucv2FomodPickerAnswers[stepIdx][groupIdx] = isRadio ? [forced[0]] : forced;
    } else {
      ucv2FomodPickerAnswers[stepIdx][groupIdx] = [];
    }
  });
}

function ucv2FomodBuildOptionRow({
  id, inputType, name, value, checked, disabled, label, preset, title, onChange,
}) {
  const row = document.createElement('label');
  row.className = `ucv2-fomod-option${disabled ? ' is-disabled' : ''}`;
  row.htmlFor = id;
  if (title) row.title = title;
  const input = document.createElement('input');
  input.type = inputType;
  input.id = id;
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', onChange);
  row.appendChild(input);
  const span = document.createElement('span');
  span.textContent = label;
  if (preset) {
    const presetSpan = document.createElement('span');
    presetSpan.className = 'ucv2-fomod-option__preset';
    presetSpan.textContent = ' (Preset)';
    span.appendChild(presetSpan);
  }
  row.appendChild(span);
  return row;
}

// Real DOM nodes with real event listeners (closures over the plugin object), NOT innerHTML with
// inline attribute strings -- a real option name like "JK's Castle Dour" contains an apostrophe,
// which breaks out of a single-quoted inline attribute string (confirmed live while building the
// approved mockup).
function ucv2FomodBuildGroupEl(need, stepIdx, group, groupIdx) {
  const groupEl = document.createElement('div');
  groupEl.className = 'ucv2-fomod-group';
  const nameEl = document.createElement('div');
  nameEl.className = 'ucv2-fomod-group__name';
  nameEl.textContent = group.name;
  groupEl.appendChild(nameEl);

  if (group.type === 'SelectAll') {
    const p = document.createElement('p');
    p.className = 'ucv2-fomod-group__all';
    p.textContent = 'Everything in this group installs automatically -- nothing to choose.';
    groupEl.appendChild(p);
    return groupEl;
  }

  const isRadio = group.type === 'SelectExactlyOne' || group.type === 'SelectAtMostOne';
  const inputName = ucv2FomodGroupInputName(stepIdx, groupIdx);
  const flags = ucv2FomodFlagsUpTo(need, ucv2FomodPickerAnswers, stepIdx, groupIdx);
  const presetNames = ucv2FomodPresetNames(need, stepIdx, groupIdx);
  const selected = new Set((ucv2FomodPickerAnswers[stepIdx] && ucv2FomodPickerAnswers[stepIdx][groupIdx]) || []);

  // A real "(None)" radio, so a genuine zero-selection SelectAtMostOne choice is representable
  // without needing custom radio-deselect behavior no browser supports natively.
  if (group.type === 'SelectAtMostOne') {
    groupEl.appendChild(ucv2FomodBuildOptionRow({
      id: `${inputName}-none`, inputType: 'radio', name: inputName, value: '-1',
      checked: selected.size === 0, disabled: false, label: '(None)', preset: false,
      onChange: () => ucv2FomodOnSelect(stepIdx, groupIdx, []),
    }));
  }

  group.plugins.forEach((plugin, idx) => {
    const type = ucv2FomodResolveType(plugin.typeDescriptor, flags);
    const isRequired = type === 'Required';
    const isNotUsable = type === 'NotUsable';
    const row = ucv2FomodBuildOptionRow({
      id: `${inputName}-${idx}`,
      inputType: isRadio ? 'radio' : 'checkbox',
      name: inputName,
      value: String(idx),
      checked: selected.has(idx),
      disabled: isNotUsable || isRequired,
      label: plugin.name,
      preset: presetNames.has((plugin.name || '').trim()),
      title: isNotUsable ? 'Not available with your other current picks' : (isRequired ? 'Required -- always installed' : undefined),
      onChange: () => {
        let next;
        if (isRadio) {
          next = [idx];
        } else {
          const cur = new Set((ucv2FomodPickerAnswers[stepIdx] && ucv2FomodPickerAnswers[stepIdx][groupIdx]) || []);
          if (cur.has(idx)) cur.delete(idx); else cur.add(idx);
          next = [...cur];
        }
        ucv2FomodOnSelect(stepIdx, groupIdx, next);
      },
    });
    row.addEventListener('mouseenter', () => ucv2FomodShowPreview(plugin, row));
    groupEl.appendChild(row);
  });

  return groupEl;
}

// Selecting an option can change OTHER options' real type (a dynamic typeDescriptor pattern keyed
// on this group's own conditionFlags) or a later step's own visibility -- re-rendering the whole
// step on every change is simple and correct (matches the real engine's own re-evaluate-on-select
// behavior) and the DOM here is small enough that this is never a real performance concern.
function ucv2FomodOnSelect(stepIdx, groupIdx, next) {
  ucv2FomodPickerAnswers[stepIdx] = ucv2FomodPickerAnswers[stepIdx] || {};
  ucv2FomodPickerAnswers[stepIdx][groupIdx] = next;
  ucv2FomodRenderStep();
}

// Hover-driven, not click/selection-driven -- confirmed against real Vortex (InstallerDialog.tsx's
// own `onMouseOver={this.showDescription}`). No real image bytes are fetched (see the block comment
// above) -- shows the real relative path from the archive as text, matching the approved mockup's
// own bracketed-placeholder approach.
function ucv2FomodShowPreview(plugin, rowEl) {
  document.querySelectorAll('#ucv2FomodPickerOptions .ucv2-fomod-option.is-active').forEach((r) => r.classList.remove('is-active'));
  if (rowEl) rowEl.classList.add('is-active');
  const el = $ucv2('ucv2FomodPickerPreview');
  if (!plugin || (!plugin.image && !plugin.description)) {
    el.innerHTML = '<div class="ucv2-fomod-preview__empty">Hover over an option to see its image and description.</div>';
    return;
  }
  const imgHtml = plugin.image
    ? `<div class="ucv2-fomod-preview__image">🖼️ ${escHtmlUcv2(plugin.image)}</div>`
    : '';
  const descHtml = plugin.description
    ? `<div class="ucv2-fomod-preview__desc">${escHtmlUcv2(plugin.description).replace(/\r?\n/g, '<br>')}</div>`
    : '';
  el.innerHTML = imgHtml + descHtml;
}

function ucv2FomodRenderStep() {
  const need = ucv2FomodPickerNeeds[ucv2FomodPickerIndex];
  const steps = need.parsedFomod.installSteps;
  const stepIdx = ucv2FomodPickerStepIdx;
  const step = steps[stepIdx];
  const total = ucv2FomodPickerNeeds.length;

  $ucv2('ucv2FomodPickerTitle').textContent = need.parsedFomod.moduleName || need.name;
  $ucv2('ucv2FomodPickerStepName').textContent = step.name;
  $ucv2('ucv2FomodPickerCounter').textContent = total > 1 ? `Mod ${ucv2FomodPickerIndex + 1} of ${total}` : '';
  const introEl = $ucv2('ucv2FomodPickerIntro');
  // The framing sentence only makes sense once -- real Vortex's own wizard drops it after page 1
  // too (just the title + step name from then on).
  introEl.style.display = stepIdx === 0 ? '' : 'none';
  introEl.textContent = need.reason === 'open'
    ? "This collection didn't record a choice for this mod's installer -- pick what you want installed, same as Vortex's own FOMOD wizard would ask."
    : "This mod's real install options changed since the collection recorded its choice, so it can't be replayed automatically -- make a fresh pick. Anything marked (Preset) matches what the collection originally recorded.";
  $ucv2('ucv2FomodPickerError').classList.add('hidden');

  ucv2FomodInitStepAnswersOnce(need, stepIdx);

  const optionsEl = $ucv2('ucv2FomodPickerOptions');
  optionsEl.innerHTML = '';
  step.groups.forEach((group, groupIdx) => optionsEl.appendChild(ucv2FomodBuildGroupEl(need, stepIdx, group, groupIdx)));
  optionsEl.scrollTop = 0;
  ucv2FomodShowPreview(null); // empty until hover, matches real Vortex

  const visibility = ucv2FomodComputeStepVisibility(need, ucv2FomodPickerAnswers);
  let lastVisibleIdx = -1;
  for (let i = 0; i < stepIdx; i++) if (visibility[i]) lastVisibleIdx = i;
  let nextVisibleIdx = -1;
  for (let i = stepIdx + 1; i < steps.length; i++) { if (visibility[i]) { nextVisibleIdx = i; break; } }
  ucv2FomodPickerPrevStepIdx = lastVisibleIdx;
  ucv2FomodPickerNextStepIdx = nextVisibleIdx;

  const backBtn = $ucv2('ucv2FomodPickerBack');
  if (lastVisibleIdx === -1) {
    backBtn.style.visibility = 'hidden';
  } else {
    backBtn.style.visibility = 'visible';
    backBtn.textContent = steps[lastVisibleIdx].name;
  }

  const nextBtn = $ucv2('ucv2FomodPickerNext');
  const isLastMod = ucv2FomodPickerIndex === total - 1;
  nextBtn.textContent = nextVisibleIdx === -1
    ? (isLastMod ? 'Apply These Choices' : 'Finish & Next Mod →')
    : steps[nextVisibleIdx].name;

  // Real formula, confirmed from source: ProgressBar now={idx} max={steps.length-1}.
  $ucv2('ucv2FomodPickerProgressFill').style.width = `${Math.round((stepIdx / Math.max(steps.length - 1, 1)) * 100)}%`;
}

// Validates the CURRENT step's own answers before advancing -- SelectExactlyOne/SelectAtLeastOne
// actually got a real selection, matching the real FOMOD spec's own requirement rather than
// leaving it for the server to reject after the fact.
function ucv2FomodValidateStep(need, stepIdx) {
  const step = need.parsedFomod.installSteps[stepIdx];
  const stepAnswers = ucv2FomodPickerAnswers[stepIdx] || {};
  for (let groupIdx = 0; groupIdx < step.groups.length; groupIdx++) {
    const group = step.groups[groupIdx];
    if (group.type === 'SelectAll') continue;
    const indices = stepAnswers[groupIdx] || [];
    if (group.type === 'SelectExactlyOne' && indices.length !== 1) {
      return `"${step.name}" / "${group.name}" needs exactly one pick.`;
    }
    if (group.type === 'SelectAtLeastOne' && indices.length < 1) {
      return `"${step.name}" / "${group.name}" needs at least one pick.`;
    }
  }
  return null;
}

function ucv2FomodGoBack() {
  if (ucv2FomodPickerPrevStepIdx === -1) return;
  ucv2FomodPickerStepIdx = ucv2FomodPickerPrevStepIdx;
  ucv2FomodRenderStep();
}
$ucv2('ucv2FomodPickerBack').addEventListener('click', ucv2FomodGoBack);

function ucv2FomodPickerAdvance() {
  const need = ucv2FomodPickerNeeds[ucv2FomodPickerIndex];
  const error = ucv2FomodValidateStep(need, ucv2FomodPickerStepIdx);
  if (error) {
    const err = $ucv2('ucv2FomodPickerError');
    err.textContent = error;
    err.classList.remove('hidden');
    return;
  }
  if (ucv2FomodPickerNextStepIdx !== -1) {
    ucv2FomodPickerStepIdx = ucv2FomodPickerNextStepIdx;
    ucv2FomodRenderStep();
    return;
  }
  // Done with every visible step for this mod -- commit its picks (the same {[stepIdx]:
  // {[groupIdx]: number[]}} shape buildFomodChoicesFromPicks already expects, unchanged), then
  // move to the next mod in the queue, or finish entirely.
  ucv2FomodPicks = { ...ucv2FomodPicks, [need.modId]: ucv2FomodPickerAnswers };
  if (ucv2FomodPickerIndex < ucv2FomodPickerNeeds.length - 1) {
    ucv2FomodPickerIndex += 1;
    ucv2FomodPickerStepIdx = 0;
    ucv2FomodPickerAnswers = {};
    ucv2FomodRenderStep();
  } else {
    $ucv2('ucv2FomodPickerModal').classList.remove('open');
    const onDone = ucv2FomodPickerOnDone;
    ucv2FomodPickerOnDone = null;
    if (onDone) onDone();
  }
}
$ucv2('ucv2FomodPickerNext').addEventListener('click', ucv2FomodPickerAdvance);
function ucv2CloseFomodPicker() {
  $ucv2('ucv2FomodPickerModal').classList.remove('open');
  const applyBtn = $ucv2('ucv2ApplyUpdateBtn');
  applyBtn.disabled = false;
  applyBtn.textContent = 'Apply Update →';
}
$ucv2('ucv2FomodPickerClose').addEventListener('click', ucv2CloseFomodPicker);
$ucv2('ucv2FomodPickerCancel').addEventListener('click', ucv2CloseFomodPicker);

let ucv2ApplyProgressTimer = null;

function ucv2StopApplyProgressPolling() {
  if (ucv2ApplyProgressTimer) { clearInterval(ucv2ApplyProgressTimer); ucv2ApplyProgressTimer = null; }
  $ucv2('ucv2ApplyProgress').classList.add('hidden');
}

// Polls the real full-deploy status (runner.applyUpdate's own deployAllResult step, via GET
// /apply-progress) WHILE the main /apply POST above is still in flight -- Node's own event loop can
// genuinely serve this concurrently, since /apply's own await is on outstanding Helper I/O, not
// synchronous CPU work. Harmless when nothing is happening (the server always answers with
// active:false, so the status line just stays hidden -- true for every apply that never needed a
// full redeploy at all). A poll can genuinely fail or return stale data mid-deploy -- confirmed real,
// documented limitation (a full Vortex deploy can make the Helper's own HTTP server look
// unresponsive for extended stretches while it's still working normally, see
// vortex-helper-client.js's own header comment) -- a failed poll is silently skipped here, never
// shown as an error, since /apply's own eventual success/failure is the real source of truth, not
// this purely-informational side channel.
function ucv2StartApplyProgressPolling() {
  const el = $ucv2('ucv2ApplyProgress');
  const textEl = $ucv2('ucv2ApplyProgressText');
  ucv2ApplyProgressTimer = setInterval(async () => {
    let progress;
    try {
      progress = await ucv2Api('GET', '/api/update-collection-v2/apply-progress');
    } catch {
      return;
    }
    if (progress && progress.active) {
      el.classList.remove('hidden');
      const pct = typeof progress.percent === 'number' && progress.percent > 0 ? ` (${Math.round(progress.percent)}%)` : '';
      textEl.textContent = `${progress.text || 'Redeploying via Vortex…'}${pct}`;
    }
  }, 1500);
}

async function ucv2ConfirmApply(extra) {
  $ucv2('ucv2ApplyConfirmModal').classList.remove('open');
  ucv2HideCriticalError();
  const applyBtn = $ucv2('ucv2ApplyUpdateBtn');
  applyBtn.disabled = true;
  applyBtn.textContent = 'Applying…';
  $ucv2('ucv2Loading').classList.remove('hidden');
  // Advance the stepper to "Apply" the moment the real apply request actually goes out -- there's
  // no separate screen for this step (unlike Cycle Helper's chScreenApply), it happens inline here.
  ucv2RenderStepper(2);
  ucv2StartApplyProgressPolling();
  try {
    const result = await ucv2Api('POST', '/api/update-collection-v2/apply', {
      collectionModId: ucv2ActiveReviewModId,
      removedChoice: ucv2CurrentReview.removed.length > 0 ? ucv2RemovedChoice : undefined,
      keepInstalledModIds: [...ucv2KeepInstalledModIds],
      deleteArchives: ucv2DeleteArchives,
      fomodPicks: ucv2FomodPicks,
      ...(extra || {}),
    });
    ucv2RenderApplyResult(result);
    $ucv2('ucv2CancelReviewBtn').textContent = 'Back to Collections';
  } catch (e) {
    if (e.status === 409 && e.body?.error === 'dependency-breaks-found') {
      ucv2ShowDependencyBreakModal(e.body.dependencyBreaks || []);
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply Update →';
      return;
    }
    if (e.status === 409 && e.body?.error === 'fomod-choices-needed') {
      ucv2ShowFomodPicker(e.body.fomodChoiceNeeds || [], () => ucv2ConfirmApply());
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply Update →';
      return;
    }
    applyBtn.disabled = false;
    applyBtn.textContent = 'Apply Update →';
    // A real retry, not a no-op -- re-runs this SAME apply call (same extra flags, e.g. a
    // dependency-break already resolved earlier in this attempt), needed for the new
    // helper-unavailable modal's own "Try Again" to genuinely do something (2026-08-18: this was a
    // pre-existing no-op here, which would have silently carried over into that modal too).
    ucv2HandleError(e, () => ucv2ConfirmApply(extra));
  } finally {
    $ucv2('ucv2Loading').classList.add('hidden');
    ucv2StopApplyProgressPolling();
  }
}
$ucv2('ucv2ApplyConfirmOk').addEventListener('click', () => ucv2ConfirmApply());

function ucv2ApplyRowLine(r) {
  const icon = r.ok === true ? '✓' : r.ok === false ? '✗' : '—';
  return `<li>${icon} ${escHtmlUcv2(r.name)}${r.error ? ` — ${escHtmlUcv2(r.error)}` : r.action ? ` — ${escHtmlUcv2(r.action)}` : ''}</li>`;
}

function ucv2RenderApplyResult(result) {
  $ucv2('ucv2ReviewActions').classList.add('hidden');
  const box = $ucv2('ucv2ApplyResult');
  box.classList.remove('hidden');
  const allUpdatedOk = result.updatedResults.every((r) => r.ok !== false);
  const allRemovedOk = result.removedResults.every((r) => r.ok !== false);
  const allAddedOk = (result.addedResults || []).every((r) => r.ok !== false);
  const allDisabledOk = (result.disabledResults || []).every((r) => r.ok !== false);
  const allRulesOk = !result.modRulesResult || (!result.modRulesResult.error && (result.modRulesResult.modsChanged || []).every((m) => m.ok !== false));
  const allDependencyBreaksOk = (result.dependencyBreakResults || []).every((r) => r.ok !== false);
  const allArchiveDeletesOk = (result.deletedArchiveResults || []).every((r) => r.ok !== false);
  const allOk = allUpdatedOk && allRemovedOk && allAddedOk && allDisabledOk && allRulesOk && allDependencyBreaksOk && allArchiveDeletesOk;
  const summary = $ucv2('ucv2ApplyResultSummary');
  summary.className = allOk ? 'callout' : 'callout callout--warning';
  summary.innerHTML = `<div class="callout__title">${allOk ? '✓ Applied' : '⚠️ Applied with some problems'}</div>`
    + `Now on Rev ${escHtmlUcv2(result.newRevisionNumber)}. Backup saved${result.backupPath ? ` to <code>${escHtmlUcv2(result.backupPath)}</code>` : ''}.`
    + (result.collectionJsonUpdated ? '' : ' (Could not update the local collection record -- the next Check for Updates may show this same diff again.)');

  const parts = [];
  // Full-deploy result (2026-08-18) -- real Vortex source confirmed (docs/VORTEX-DEPLOY-REFERENCE.md):
  // this apply deploys through Vortex's per-mod deploy-single-mod event, which never fires the real
  // did-deploy event -- the ONLY thing that makes gamebryo-plugin-management rescan known plugins and
  // LOOT-resort plugins.txt/loadorder.txt. When this apply added, removed, or renamed an actual
  // plugin (.esp/.esm/.esl) file, this tool triggers a REAL full Vortex deploy (the same deploy-mods
  // event the actual Deploy Mods button dispatches, via the Helper's own /mods/deploy-all) so that
  // reconciliation happens automatically -- see runner.applyUpdate's own deployAllResult. Falls back
  // to telling the user plainly ONLY if that real trigger didn't confirm success. Serious register
  // (per DESIGN.md's "Never run a real action silently" standing rule) and placed FIRST, above even
  // the curated-collection note -- this is the one thing on this screen that can genuinely affect
  // whether the game loads correctly, not just informational.
  if (result.deployAllResult && result.deployAllResult.attempted) {
    if (result.deployAllResult.ok) {
      parts.push('<div class="callout" style="margin:14px 0 6px">'
        + '<div class="callout__title">✓ Vortex redeployed automatically</div>'
        + 'This update added, removed, or renamed a plugin file, so this tool ran a real full Vortex '
        + 'deploy for you -- <code>plugins.txt</code> and your load order are already refreshed. Nothing '
        + 'else to do here.'
        + '</div>');
    } else {
      parts.push('<div class="callout callout--warning" style="margin:14px 0 6px">'
        + '<div class="callout__title">⚠️ Run Vortex\'s Deploy Mods next</div>'
        + 'This update added, removed, or renamed a plugin file, so this tool tried to trigger a real '
        + `full Vortex deploy automatically, but it didn't confirm success${result.deployAllResult.error ? ` (${escHtmlUcv2(result.deployAllResult.error)})` : ''}. `
        + 'Open Vortex and click <strong>Deploy Mods</strong> yourself before you play, so <code>plugins.txt</code> '
        + 'and your load order actually reflect what just changed.'
        + '</div>');
    }
  }
  // "You curated this collection" (2026-08-18) -- purely informational, so it's casual register and
  // sits above the per-section detail lists, not gating or blocking anything. No in-app Edit
  // button/deep-link -- this project can't replicate Vortex's own Workshop collection editor, so it
  // just points there.
  if (result.isOwnCollection) {
    parts.push('<div class="callout callout--info" style="margin:14px 0 6px">'
      + '<div class="callout__title">🎨 You curated this collection!</div>'
      + 'Want to tweak anything -- swap a mod, change a rule? Head over to the <strong>Workshop</strong> tab in Vortex to edit it there.'
      + '</div>');
  }
  if (result.updatedResults.length > 0) {
    parts.push(`<p style="margin:14px 0 6px"><strong>Updated</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${result.updatedResults.map(ucv2ApplyRowLine).join('')}</ul>`);
  }
  if (result.removedResults.length > 0) {
    parts.push(`<p style="margin:14px 0 6px"><strong>Removed</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${result.removedResults.map(ucv2ApplyRowLine).join('')}</ul>`);
  }
  if ((result.disabledResults || []).length > 0) {
    parts.push(`<p style="margin:14px 0 6px"><strong>Kept disabled</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${result.disabledResults.map((r) => `<li>${r.ok === false ? '✗' : '✓'} ${escHtmlUcv2(r.name)}${r.error ? ` — ${escHtmlUcv2(r.error)}` : ' — set back to Disabled after the update'}</li>`).join('')}</ul>`);
  }
  if ((result.dependencyBreakResults || []).length > 0) {
    parts.push(`<p style="margin:14px 0 6px"><strong>Dependency warnings acknowledged</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${result.dependencyBreakResults.map((r) => `<li>${r.ok === false ? '✗' : '✓'} ${escHtmlUcv2(r.name)}${r.error ? ` — ${escHtmlUcv2(r.error)}` : ''}</li>`).join('')}</ul>`);
  }
  if ((result.deletedArchiveResults || []).length > 0) {
    parts.push(`<p style="margin:14px 0 6px"><strong>Archives deleted</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${result.deletedArchiveResults.map((r) => `<li>${r.ok === false ? '✗' : '✓'} ${escHtmlUcv2(r.name)}${r.error ? ` — ${escHtmlUcv2(r.error)}` : ' — archive file deleted'}</li>`).join('')}</ul>`);
  }
  // Matches Vortex's own real finalize wording ("Finalizing installation - deploying mods and
  // applying collection rules...") -- a summary line, not a per-rule list, since that's the same
  // level of detail Vortex's own real UI shows for this step. Only the failures get their own lines,
  // so a problem is still visible without burying a clean run in rule-by-rule noise.
  const mrr = result.modRulesResult;
  if (mrr && (mrr.totalRulesWritten > 0 || mrr.error || (mrr.modsChanged || []).some((m) => m.ok === false))) {
    const failed = (mrr.modsChanged || []).filter((m) => m.ok === false);
    const ok = failed.length === 0 && !mrr.error;
    const lines = [`<li>${ok ? '✓' : '✗'} Applied collection rules — ${mrr.totalRulesWritten} rule${mrr.totalRulesWritten === 1 ? '' : 's'} set across ${(mrr.modsChanged || []).filter((m) => m.ok).length} mod${(mrr.modsChanged || []).filter((m) => m.ok).length === 1 ? '' : 's'}.</li>`];
    if (mrr.error) lines.push(`<li>✗ ${escHtmlUcv2(mrr.error)}</li>`);
    failed.forEach((m) => lines.push(`<li>✗ ${escHtmlUcv2(m.name)} — ${escHtmlUcv2(m.error || 'Rule apply failed.')}</li>`));
    parts.push(`<p style="margin:14px 0 6px"><strong>Collection rules</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${lines.join('')}</ul>`);
  }
  if (result.addedResults.length > 0) {
    parts.push(`<p style="margin:14px 0 6px"><strong>Added</strong></p><ul style="margin:0;padding-left:20px;font-size:13px">${result.addedResults.map(ucv2ApplyRowLine).join('')}</ul>`);
  }
  $ucv2('ucv2ApplyResultList').innerHTML = parts.join('');
  window.scrollTo(0, 0);
}

// Jumps to Update Collection (Classic) -- the callout's own inline link at the top of screen1.
const ucv2ClassicLink = $ucv2('ucv2ClassicLink');
if (ucv2ClassicLink) {
  ucv2ClassicLink.addEventListener('click', (e) => { e.preventDefault(); window.navigateToArea('sync'); });
}
