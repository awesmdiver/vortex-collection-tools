'use strict';
// Update Collection v2 UI (Phase 1: read-only Check for Updates + Review, no real apply/deploy yet)
// -- talks only to /api/update-collection-v2/*. See design/vortex-update-collection-v2-mockup.html
// for the approved UI this mirrors and TECHNICAL.md's "Update Collection v2" section for the full
// design writeup. Own tiny api()/$ helpers, same reasoning as rules-generator-app.js's own
// (independent of app.js, safe to work on without touching already-validated code).

function $ucv2(id) { return document.getElementById(id); }

// Declared up here, ahead of the stepper section below, on purpose (2026-08-26): ucv2Steps() reads
// this at module-load time (the initial ucv2RenderStepper(0) call), and a `let` declared further
// down the file is in the temporal dead zone until its own line actually runs -- confirmed real, this
// broke the stepper's very first render with "Cannot access before initialization" until moved here.
let ucv2CurrentReview = null; // the in-progress review's own fetched {removed, updated, added, ...}

function escHtmlUcv2(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Every version-display call site below used to prepend its own literal "v" -- a real, live-caught
// bug (2026-08-29, director's own catch): a collection.json version string can already carry its OWN
// "v" prefix (e.g. "v1.0.1", "v4.4.0-beta" -- confirmed real on this exact test collection), and
// blindly prepending another produced "vv1.0.1" in the Review table. Director's own call: don't try
// to guess/normalize this at all -- just show the raw version string exactly as Vortex itself shows
// it, verbatim, same convention as every other real field this project displays (name, author, etc).
// Fields of a review the server can leave out or send as null must never throw in the page (2026-10-23): every
// list is an array from here on.
const UCV2_REVIEW_LIST_FIELDS = ['removed', 'updated', 'added', 'unchanged', 'ignored', 'optionalMods', 'modRules', 'revisions', 'finishDetails', 'strayArchives', 'oldDownloads', 'staleArrows', 'duplicateCopies', 'checksIncomplete', 'unfinished', 'picksOnlyMods', 'olderInstalled'];
function ucv2NormalizeReview(review) {
  if (!review || typeof review !== 'object') return review;
  for (const f of UCV2_REVIEW_LIST_FIELDS) if (!Array.isArray(review[f])) review[f] = [];
  // A removal for a mod that is not installed has nothing to show or count (the server still clears its leftover
  // rule when it applies); it stays out of the table, the counts and the Apply screen.
  review.removedHidden = review.removed.filter((m) => m && m.notInstalled);
  review.removed = review.removed.filter((m) => !(m && m.notInstalled));
  return review;
}
function ucv2VersionLabel(v) {
  return String(v ?? '?');
}

// Read-only POSTs that may be sent again after a network failure (vct-fetch.js already retries GETs).
const UCV2_SAFE_TO_RETRY_POSTS = ['/api/update-collection-v2/check-updates', '/api/update-collection-v2/review'];
async function ucv2Api(method, path, body) {
  const send = () => fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let res;
  try {
    res = await send();
  } catch (e) {
    if (!(e instanceof TypeError) || !UCV2_SAFE_TO_RETRY_POSTS.includes(path)) throw e;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    res = await send();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// retryFn is optional -- when given, a Retry button renders in the callout (same btn--ghost btn--small
// pattern the per-line problem-retry buttons already use) that re-runs it and clears the callout.
function ucv2ShowCriticalError(message, retryFn, title, retryLabel) {
  const el = $ucv2('ucv2CriticalError');
  const friendly = ucv2FriendlyErrorMessage(message);
  el.innerHTML = `<div class="callout__title">${escHtmlUcv2(title || "🛑 Couldn't do that")}</div><p>${escHtmlUcv2(friendly)}</p>`
    + (retryFn ? `<button type="button" class="btn btn--ghost btn--small" id="ucv2CriticalErrorRetry">${escHtmlUcv2(retryLabel || 'Retry')}</button>` : '');
  if (retryFn) {
    $ucv2('ucv2CriticalErrorRetry').addEventListener('click', () => {
      ucv2HideCriticalError();
      retryFn();
    });
  }
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
    // Update Collection v2's own two read-only fallback throw sites (checkForUpdates/reviewUpdate in
    // the runner, 2026-08-30) send a distinct message for "Vortex Bridge didn't answer, Vortex is probably
    // just busy" -- shown verbatim instead of the shared modal's default "close it completely"
    // wording, which is actively wrong advice for that real case. Every OTHER vortex-running here
    // (a genuine real-write path) still has no message override and shows the original text.
    const isBusy = /currently busy/i.test(e.body?.message || '');
    window.showVortexRunningModal(retryFn || (() => {}), isBusy ? {
      title: '⚠️ Vortex is currently busy',
      body: e.body.message,
    } : undefined);
    return;
  }
  // The Vortex Bridge was reachable when this v2 flow started (Update Collection's own upfront check would
  // have routed to Classic otherwise) but died partway through -- Vortex closed, or the extension
  // crashed. Same shared-modal pattern as vortex-running, plus its own "Switch to Classic instead"
  // escape hatch (shell.js's showBridgeUnavailableModal).
  if (e.status === 409 && e.body?.error === 'bridge-unavailable') {
    window.showBridgeUnavailableModal(retryFn || (() => {}));
    return;
  }
  ucv2ShowCriticalError(e.message, retryFn);
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

// Curator's own install instructions (2026-08-28) -- collection.json's info.installInstructions,
// read server-side (update-collection-v2-runner.js's reviewUpdate) and passed through as-is. Curator's
// own real text, not app-authored copy -- displayed verbatim via textContent (real line breaks
// preserved by the .callout__body element's own white-space:pre-line, no manual escaping/formatting
// needed), never rewritten. Shared between the Removed and Review screens, which both show it (the
// director's own call: he needs to re-read it before every real change, not just the first time).
// Hidden entirely -- not an empty callout -- when the collection didn't set one.
function ucv2RenderInstructions(containerId, bodyId) {
  const has = typeof ucv2CurrentReview?.installInstructions === 'string' && ucv2CurrentReview.installInstructions;
  $ucv2(containerId).classList.toggle('hidden', !has);
  $ucv2(bodyId).textContent = has || '';
}

// ---- Stepper (2026-08-18, dynamic since 2026-08-26) -- this app's own standard multi-step
// component (DESIGN.md's "Stepper -- the standard for multi-step tools"), already used by Cycle
// Vortex Bridge/Merge Plugins (.merge-stepper/.merge-step, cycle-helper-app.js's CH_STEPS/chRenderStepper)
// -- mirrored directly rather than inventing a second implementation.
//
// Removed-mods gets its own REAL step ("Remove") now, not folded into Review as a same-index
// sub-screen -- director's own call, 2026-08-26: "since remove is it's own page, there should be [a]
// step for it." Only shown when the current revision actually drops mods (ucv2ScreenRemoved is
// skipped entirely otherwise, per ucv2StartReview's own branch), so the step LIST itself is dynamic
// per review rather than one fixed constant. There's no separate screen for Apply (the real POST
// happens inline on ucv2Screen2, see ucv2ConfirmApply) -- the last step's own index is passed
// explicitly at the moment the real apply request actually goes out.
// Optional Installs gets its own real step (2026-08-28, director's own call: "optional mods should
// have their own pill since it really is another step") -- same conditional-step pattern Remove
// already established above (only added when this revision's own review.optionalMods is non-empty,
// known from the SAME review response hasRemoved already reads).
function ucv2Steps() {
  const hasRemoved = (ucv2CurrentReview?.removed?.length || 0) > 0;
  const hasOptional = (ucv2CurrentReview?.optionalMods?.length || 0) > 0;
  const steps = ['Pick a collection'];
  if (hasRemoved) steps.push('Remove');
  steps.push('Review', 'Apply');
  if (hasOptional) steps.push('Optional Installs');
  return steps;
}
function ucv2RenderStepper(activeIdx) {
  const steps = ucv2Steps();
  $ucv2('ucv2Stepper').innerHTML = steps.map((label, i) => {
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
const UCV2_SCREEN_IDS = ['ucv2Screen1', 'ucv2ScreenRemoved', 'ucv2Screen2', 'ucv2ScreenApplyProgress', 'ucv2ScreenOptionalInstalls', 'ucv2ScreenApplyResult'];
// Index depends on whether Remove/Optional Installs are real steps this review (see ucv2Steps above).
// Apply Progress and Apply Result stay pinned to the "Apply" step's own index while showing the MAIN
// apply pass (2026-08-23, live feedback: "we don't have a Complete pill, it still says 3, Apply" --
// so ucv2RenderStepper's own `i < activeIdx ? 'done' : ...` checkmarks Apply too rather than reading
// as still in-progress) -- but once the director has actually moved into the Optional Installs step,
// those SAME two screens (now showing the optional-mods apply pass) map to Optional Installs' own
// index instead, per ucv2OptionalFlowActive below.
// ucv2OptionalFlowActive (2026-08-28) -- true once the director has actually moved into the Optional
// Installs step (either opened the picker screen, or hit "Install all" and skipped straight to the
// optional apply pass), false otherwise. Needed because ucv2ScreenApplyProgress/ucv2ScreenApplyResult
// are shared between the MAIN apply pass (still the "Apply" step) and an optional-mods apply pass
// (now its own "Optional Installs" step) -- the screen id alone can't tell those two apart. Set true
// in ucv2RenderOptionalInstallsScreen/ucv2StartOptionalApply, reset false on every fresh review.
let ucv2OptionalFlowActive = false;
// The exact mods array a currently-in-flight (or just-failed) ucv2StartOptionalApply call was given
// -- needed (2026-08-31) so an error frame arriving on the shared apply/events stream can retry the
// SAME optional-apply call, not the main flow's. Set at the top of ucv2StartOptionalApply, read by
// ucv2HandleApplyEvent's own 'error' branch when frame.optional is true.
let ucv2LastOptionalApplyMods = null;
function ucv2ScreenStep(id) {
  const steps = ucv2Steps();
  const hasRemoved = (ucv2CurrentReview?.removed?.length || 0) > 0;
  if (id === 'ucv2Screen1') return 0;
  if (id === 'ucv2ScreenRemoved') return 1;
  if (id === 'ucv2Screen2') return hasRemoved ? 2 : 1;
  if (id === 'ucv2ScreenOptionalInstalls') return steps.indexOf('Optional Installs');
  if (id === 'ucv2ScreenApplyProgress' || id === 'ucv2ScreenApplyResult') {
    return ucv2OptionalFlowActive ? steps.indexOf('Optional Installs') : steps.indexOf('Apply');
  }
  return 0;
}
function ucv2GoScreen(id) {
  UCV2_SCREEN_IDS.forEach((s) => $ucv2(s).classList.toggle('hidden', s !== id));
  ucv2RenderStepper(ucv2ScreenStep(id));
  // Refresh only makes sense on the "Pick a collection" step -- shares the stepper's own row
  // (#ucv2RefreshRow), so it toggles here alongside the screens rather than living inside any one
  // screen's own markup.
  $ucv2('ucv2RefreshRow').classList.toggle('hidden', id !== 'ucv2Screen1');
  window.scrollTo(0, 0);
}

// Vortex itself only allows one collection update at a time -- mirrors the mockup's own
// activeReview lock exactly: every OTHER collection's "Review update" button disables while one's
// already in progress.
let ucv2ActiveReviewModId = null;
let ucv2Collections = []; // last-rendered list, from either /collections or /check-updates
// Collection rules should only ever be applied once per apply -- right before the FIRST deploy, same
// as Vortex's own native behavior (director's own call, 2026-08-31: Vortex itself only ever applies
// rules during an update/install, never on a plain deploy). fix-collection-gaps' own unconditional
// applyCollectionModRules() call was re-running on every single Deploy/Retry Deploy click, which
// could both recreate a rule cycle the director had just manually cleared AND -- live-confirmed the
// same session -- trigger a silent partial reinstall of mods, corrupting their file set (a FOMOD mod
// dropped from ~150 files to 24). This flag makes fix-collection-gaps a true one-shot: set once the
// first ucv2DeployAll() call for this review succeeds, reset only when a fresh review starts.
let ucv2GapsFixedForActiveReview = false;
// (ucv2CurrentReview itself is declared near the top of the file -- see that declaration's own
// header comment for why.)
// Per-mod keep/remove for the Removed-mods screen (2026-08-26, replacing the old all-or-nothing
// ucv2RemovedChoice) -- review.removed[].source.modId currently CHECKED = kept. Checked-by-default
// (seeded fresh in ucv2RenderRemovedScreen): the safer default protects a mod something else might
// still depend on (e.g. one flagged "required by another installed collection") rather than
// defaulting to remove everything the collection author dropped.
let ucv2KeepRemovedModIds = new Set();
let ucv2DeleteArchives = true; // whether to also delete the archive for whatever ends up actually removed -- default ON (director's own call, 2026-08-28: cleaner reruns, less orphaned disk cruft)
let ucv2FomodPicks = {}; // modId (string) -> {[stepIdx]: {[groupIdx]: number[]}} -- resolved FOMOD picks, carried across re-apply calls the same way keepInstalledModIds is
// modId (string) set -- mods whose installer failed real schema validation and this session already
// confirmed "Install Anyway" for (2026-09-15, "validate the installer against the real schema").
// Carried across re-apply calls the SAME way ucv2FomodPicks is (the retry re-runs prepareApply's own
// FOMOD gate from scratch, which would otherwise re-block on the identical already-confirmed mod).
let ucv2IgnoreFomodValidationModIds = new Set();
// Keys of the version conflicts the person chose to Ignore in this apply; sent on every round trip so the warning never comes back for the same conflict. Cleared with the other per-apply choices.
let ucv2IgnoredDependencyBreakKeys = new Set();
function ucv2UpdateReviewLockUI() {
  document.querySelectorAll('.ucv2-review-btn').forEach((btn) => {
    const isActive = btn.dataset.modId === ucv2ActiveReviewModId;
    const locked = ucv2ActiveReviewModId !== null && !isActive;
    btn.disabled = locked;
    // Explanation lives in the disabled button's own tooltip (2026-08-23) -- a permanent line of text
    // under every other card was more than a plain grayed-out button needs, and it grew each card's
    // own height, pushing the grid below down every time a review started.
    btn.title = locked ? 'Finish or cancel the update in progress first' : '';
  });
}

// ---- Screen 1: Collections overview ----

// One Deploy for every collection that finished updating (2026-10-24): a finished update waits for it, and its card
// reads "Up to date" meanwhile. New words below need their Gemini pass.
const UCV2_DEPLOY_ALL_BUSY = 'Deploying…';
const UCV2_DEPLOY_ALL_RETRY_LABEL = 'Retry Deploy';
function ucv2DeployAllLine(n) { return `${n} collection${n === 1 ? '' : 's'} updated, not deployed yet.`; }
let ucv2ListDeployInFlight = false;
function ucv2ShowDeployAllBanner({ text, failed, busy }) {
  const el = $ucv2('ucv2DeployAllBanner');
  el.classList.remove('hidden');
  el.classList.toggle('callout--warning', !!failed);
  el.classList.toggle('callout--info', !failed);
  $ucv2('ucv2DeployAllText').textContent = text;
  const btn = $ucv2('ucv2DeployAllBtn');
  btn.disabled = !!busy;
  btn.textContent = failed ? UCV2_DEPLOY_ALL_RETRY_LABEL : 'Deploy';
}
function ucv2RenderDeployAllBanner() {
  if (ucv2ListDeployInFlight) return; // the running deploy owns the banner
  const n = (Array.isArray(ucv2Collections) ? ucv2Collections : []).filter((c) => c.deployPending).length;
  if (n === 0) { $ucv2('ucv2DeployAllBanner').classList.add('hidden'); return; }
  ucv2ShowDeployAllBanner({ text: ucv2DeployAllLine(n) });
}
async function ucv2DeployFromList() {
  if (ucv2ListDeployInFlight) return;
  ucv2ListDeployInFlight = true;
  const fail = (message) => {
    ucv2ListDeployInFlight = false;
    ucv2ShowDeployAllBanner({ text: `⚠️ ${message || "Vortex didn't confirm the deploy completed."}`, failed: true });
  };
  ucv2ShowDeployAllBanner({ text: UCV2_DEPLOY_ALL_BUSY, busy: true });
  await startDeploy('/api/deploy', ucv2Api, {
    onError: (e) => fail(e && e.message),
    onTick: (progress) => {
      if (progress && progress.text) ucv2ShowDeployAllBanner({ text: `${UCV2_DEPLOY_ALL_BUSY} ${progress.text}`, busy: true });
    },
    onDone: async (progress) => {
      if (progress.error) { fail(themedCycleMessage(progress.error, progress.code, 'deploy-blocked-by-cycles')); return; }
      try { await ucv2Api('POST', '/api/update-collection-v2/deploy-done', {}); } catch { /* the next load shows what is saved */ }
      ucv2Collections = (ucv2Collections || []).map((c) => ({ ...c, deployPending: false }));
      ucv2ListDeployInFlight = false;
      ucv2RenderCollections();
    },
  });
}
window.ucv2DeployFromList = ucv2DeployFromList;

function ucv2RenderCollections() {
  const grid = $ucv2('ucv2CollectionGrid');
  const empty = $ucv2('ucv2Empty');
  if (!Array.isArray(ucv2Collections)) ucv2Collections = []; // never a crash: not-ready is handled by the callers
  ucv2RenderDeployAllBanner();
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
    // Clickable once checked, with no revision-level update available, ONLY when there's a real
    // reason to (2026-09-01, director's own framing: "if the update collection doesn't complete 100%
    // and we have an error, we can re-check -- but if it completes with no errors, then we don't show
    // it"). c.needsRecheck (lib/update-collection-v2-runner.js's own checkForUpdates/
    // computeNeedsRecheck) is the two-tier real signal -- this tool's own tracked clean-apply record
    // when it applies, Vortex's own live per-mod install/ignored/disabled status otherwise. Previously
    // (2026-08-30) this button showed unconditionally whenever `checked && !checkError &&
    // !updateAvailable` -- correct for catching real local-tracking drift, but confusing on a
    // genuinely complete collection with nothing left to reconcile (director-caught real bug,
    // screenshot evidence: a Rev 59 -> Rev 59 re-check on a fully-installed collection still offered
    // "Re-check →" with nothing to actually do). "Up to date ✓", disabled, replaces it in that case --
    // same disabled-button convention "Not checked yet"/"Couldn't check" already use, so the actions
    // row never goes visually empty.
    const actionBtn = !checked
      ? `<button class="btn btn--small" style="width:100%" disabled>Not checked yet</button>`
      : c.checkError
        ? `<button class="btn btn--small" style="width:100%" disabled>Couldn't check</button>`
        : c.updateAvailable
          ? `<button class="btn btn--primary btn--small ucv2-review-btn" data-mod-id="${escHtmlUcv2(c.modId)}" data-ucv2-action="review" style="width:100%">Review update →</button>`
          : c.needsRecheck
            ? `<button class="btn btn--ghost btn--small ucv2-review-btn" data-mod-id="${escHtmlUcv2(c.modId)}" data-ucv2-action="continue" style="width:100%">Continue update →</button>`
            : `<button class="btn btn--small" style="width:100%" disabled>Up to date ✓</button>`;
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
  // One listener on the grid instead of an inline onclick per button: a collection id is outside text and must never be
  // part of script. Wired once; the grid element stays for the life of the page.
  if (!grid.dataset.actionsWired) {
    grid.dataset.actionsWired = '1';
    grid.addEventListener('click', (ev) => {
      const btn = ev.target.closest && ev.target.closest('button[data-ucv2-action]');
      if (!btn || btn.disabled || !grid.contains(btn)) return;
      if (btn.dataset.ucv2Action === 'continue') ucv2StartContinue(btn.dataset.modId);
      else if (btn.dataset.ucv2Action === 'review') ucv2StartReview(btn.dataset.modId);
    });
  }
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
// ucv2Loading is shared across two genuinely different contexts (2026-08-30, director-caught real
// wording bug): loading the WHOLE picker grid (ucv2LoadCollections/ucv2CheckForUpdates -- correctly
// plural) vs. loading exactly ONE collection's own review (ucv2StartReview/ucv2PickRevision/
// ucv2ConfirmApply -- Vortex itself only ever updates one collection at a time, so "collections" is
// factually wrong there). Each caller sets its own correct text explicitly on show, rather than
// leaving the DOM's static default in place -- otherwise whichever context ran LAST would leak its
// own wording into the next, unrelated context's loading row.
const UCV2_LOADING_TEXT_COLLECTIONS = 'Loading your installed collections…';
const UCV2_LOADING_TEXT_ONE_COLLECTION = 'Loading your installed collection…';
function ucv2ShowLoading(text) {
  const textEl = $ucv2('ucv2LoadingText');
  if (textEl) textEl.textContent = text;
  $ucv2('ucv2Loading').classList.remove('hidden');
}

// Real, live activity text on the Review screen itself (2026-08-30, director's own layout call) --
// left-justified, same row as Back/Apply update, NOT the picker's own #ucv2Loading (which director
// wants reserved for page 1's own plain "Refresh" action only -- a rich per-mod activity line has no
// good home there since page 1 never knows which of two possible destination screens a review will
// land on until the data actually arrives). Used both for the initial review (a loading skeleton
// shown immediately, before real data exists -- see ucv2StartReview) and for a re-review from the
// revision picker while already on this screen (ucv2PickRevision) -- same element either way.
function ucv2ShowReviewActivity(text) {
  // Updates BOTH the Review screen's own activity text and the Removed screen's own copy --
  // ucv2PickRevision can run while sitting on either one (see ucv2RemovedActivityText's own header
  // comment in index.html), and this way neither call site needs to know or care which screen is
  // actually visible right now.
  const inner = $ucv2('ucv2ReviewActivityTextInner');
  if (inner) inner.textContent = text;
  $ucv2('ucv2ReviewActivityText').classList.remove('hidden');
  const remInner = $ucv2('ucv2RemovedActivityTextInner');
  if (remInner) remInner.textContent = text;
  $ucv2('ucv2RemovedActivityText').classList.remove('hidden');
}
function ucv2HideReviewActivity() {
  $ucv2('ucv2ReviewActivityText').classList.add('hidden');
  $ucv2('ucv2RemovedActivityText').classList.add('hidden');
}

// Real, live streamed progress for Review (2026-08-30) -- POST /review now returns 202 immediately
// and streams real phase/progress events via GET /review/events, same POST-then-SSE shape /apply
// already established (see that route's own header comment in update-collection-v2-routes.js).
// Wraps the whole request+stream+result lifecycle in one Promise so every caller (ucv2StartReview,
// ucv2PickRevision) keeps its existing `const review = await ...` shape, unchanged apart from
// swapping which function they call.
// onActivity(text) -- caller-supplied so each real call site can put the live phase/progress text
// wherever actually makes sense for what's currently on screen (2026-08-30, director's own layout
// call: page 1's own #ucv2Loading is reserved for the plain "Refresh" action; a real per-mod review
// activity line belongs on the Review screen itself, left-justified next to Back/Apply update --
// see ucv2ShowReviewActivity's own header comment). Defaults to a no-op so a caller that genuinely
// has nowhere sensible to show it yet doesn't have to pass one.
function ucv2RunReviewRequest(body, onActivity = () => {}) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        await ucv2Api('POST', '/api/update-collection-v2/review', body);
      } catch (e) {
        reject(e);
        return;
      }
      const es = new EventSource('/api/update-collection-v2/review/events');
      es.onmessage = (msg) => {
        const frame = JSON.parse(msg.data);
        if (frame.type === 'phase') {
          onActivity(frame.message);
        } else if (frame.type === 'progress') {
          onActivity(frame.current && frame.total ? `${frame.current} / ${frame.total} — ${frame.message}` : frame.message);
        } else if (frame.type === 'done') {
          es.close();
          resolve(frame.result);
        } else if (frame.type === 'error') {
          es.close();
          // Reshaped to the exact {status, body} an error from ucv2Api itself would have -- every
          // existing catch block (ucv2HandleError's own 'vortex-running'/'revision-not-found' checks
          // included) keeps working unchanged, whether the failure arrived as a synchronous 4xx or,
          // now, as a stream frame.
          const err = new Error(frame.message);
          err.status = (frame.code === 'vortex-running' || frame.code === 'bridge-unavailable') ? 409
            : (frame.code === 'revision-not-found' ? 404 : 500);
          err.body = { error: frame.code || 'error', message: frame.message };
          reject(err);
        }
      };
      es.onerror = () => {
        // The connection itself dropped (server down/restarted, network blip) -- distinct from a
        // real `error` frame above (a well-formed failure the server actually told us about).
        // TypeError specifically -- isServerUnreachableError checks `e instanceof TypeError`, so this
        // deliberately routes through the SAME "server unreachable" modal a fetch()-level connection
        // failure already does, matching every other call site's convention (see shell.js's own
        // isServerUnreachableError header comment).
        es.close();
        reject(new TypeError('Lost connection to the server while reviewing.'));
      };
    })();
  });
}

let ucv2CollectionsPollTimer = null;
function ucv2StopCollectionsPolling() {
  if (ucv2CollectionsPollTimer) { clearTimeout(ucv2CollectionsPollTimer); ucv2CollectionsPollTimer = null; }
}
// An answer without a list is a normal state, not a crash (2026-10-23): the startup refresh is still running
// (collections: null, refreshing: true), or the check failed (error set). New words below need their Gemini pass.
const UCV2_COLLECTIONS_LOAD_FAILED = "Couldn't load your collections. Press Refresh to try again.";
let ucv2CollectionsEmptyPolls = 0;
function ucv2CollectionsAnswerKind(data) {
  if (data && Array.isArray(data.collections)) return 'list';
  if (data && data.error && !data.refreshing) return 'error';
  return 'pending';
}
function ucv2ShowCollectionsLoadFailed(detail) {
  const grid = $ucv2('ucv2CollectionGrid');
  const empty = $ucv2('ucv2Empty');
  grid.innerHTML = '';
  empty.textContent = '⚠️ ' + UCV2_COLLECTIONS_LOAD_FAILED;
  empty.title = detail ? String(detail) : '';
  empty.style.color = 'var(--warning)';
  empty.classList.remove('hidden');
}

async function ucv2LoadCollections() {
  ucv2HideCriticalError();
  ucv2StopCollectionsPolling();
  try {
    const data = await ucv2Api('GET', '/api/update-collection-v2/collections');
    const kind = ucv2CollectionsAnswerKind(data);
    $ucv2('ucv2Empty').style.color = '';
    $ucv2('ucv2Empty').title = '';
    if (kind === 'list') {
      ucv2CollectionsEmptyPolls = 0;
      ucv2Collections = data.collections;
      ucv2RenderCollections();
    } else if (kind === 'error') {
      $ucv2('ucv2Loading').classList.add('hidden');
      ucv2ShowCollectionsLoadFailed(data.error);
      return;
    }
    // No list yet: keep the loading state and ask again shortly (up to about a minute).
    if (kind === 'pending' ? (ucv2CollectionsEmptyPolls += 1) <= 30 : data.refreshing) {
      ucv2ShowLoading(UCV2_LOADING_TEXT_COLLECTIONS);
      ucv2CollectionsPollTimer = setTimeout(ucv2LoadCollections, 2000);
    } else {
      $ucv2('ucv2Loading').classList.add('hidden');
      if (kind === 'pending') ucv2ShowCollectionsLoadFailed(null);
    }
  } catch (e) {
    $ucv2('ucv2Loading').classList.add('hidden');
    ucv2HandleError(e, ucv2LoadCollections);
  }
}
window.ucv2LoadCollections = ucv2LoadCollections;

async function ucv2CheckForUpdates() {
  ucv2HideCriticalError();
  let keepLoading = false;
  const btn = $ucv2('ucv2CheckUpdatesBtn');
  btn.disabled = true;
  ucv2ShowLoading(UCV2_LOADING_TEXT_COLLECTIONS);
  try {
    const data = await ucv2Api('POST', '/api/update-collection-v2/check-updates');
    if (ucv2CollectionsAnswerKind(data) === 'list') {
      ucv2Collections = data.collections;
      ucv2RenderCollections();
    } else {
      // The startup refresh is still running and has no list yet: not an error. Keep the loading state
      // and let the list loader ask again until it arrives.
      keepLoading = true;
      ucv2CollectionsEmptyPolls = 0;
      ucv2CollectionsPollTimer = setTimeout(ucv2LoadCollections, 2000);
    }
  } catch (e) {
    ucv2HandleError(e, ucv2CheckForUpdates);
  } finally {
    btn.disabled = false;
    if (!keepLoading) $ucv2('ucv2Loading').classList.add('hidden');
  }
}
$ucv2('ucv2CheckUpdatesBtn').addEventListener('click', ucv2CheckForUpdates);

// ---- Review flow: Removed Mods decision (only when the diff actually has removed mods) -> Update
// Review table ----

// Continue Update groups (2026-10-23). Words below are Claude-drafted and still need their Gemini pass.
const UCV2_NOT_INSTALLED_REMOVE_TIP = "This mod isn't installed. Only its leftover entry in the collection gets cleared.";
const UCV2_FINISH_DETAILS_HELP = 'These mods already have the new files. Vortex just never saved their new details. This saves them. Nothing is downloaded or installed again.';
const UCV2_LINK_DOWNLOADS_HELP = 'Vortex lists these mods twice: once for the mod and once for its newer download. This points each mod at its newer download and removes the old download it replaces. Nothing is downloaded or installed again.';
const UCV2_DUPLICATES_HELP = 'Vortex has two copies of each of these. Nothing is removed here. Use Duplicate Version Cleanup to remove one.';

// Long lists show their first 3 items and open to the rest. Open/closed is kept per group here, so a
// re-draw of the review (it refreshes while it runs) does not snap an open list shut.
const UCV2_LIST_PREVIEW_COUNT = 3;
const ucv2OpenLists = new Set();

function ucv2LimitedListHtml(key, itemsHtml) {
  const head = `<ul>${itemsHtml.slice(0, UCV2_LIST_PREVIEW_COUNT).join('')}</ul>`;
  if (itemsHtml.length <= UCV2_LIST_PREVIEW_COUNT) return head;
  const open = ucv2OpenLists.has(key);
  return head + `<details class="chip-list-details" data-ucv2-list="${key}" data-ucv2-total="${itemsHtml.length}"${open ? ' open' : ''}><summary><span class="chip-list-details__caret">▸</span> `
    + `<span class="ucv2-list-toggle-label">${open ? 'Show fewer' : `Show all ${itemsHtml.length}`}</span></summary>`
    + `<div class="chip-list-details__body"><ul>${itemsHtml.slice(UCV2_LIST_PREVIEW_COUNT).join('')}</ul></div></details>`;
}

function ucv2WireLimitedLists(box) {
  for (const d of box.querySelectorAll('details[data-ucv2-list]')) {
    d.addEventListener('toggle', () => {
      const key = d.dataset.ucv2List;
      if (d.open) ucv2OpenLists.add(key); else ucv2OpenLists.delete(key);
      const label = d.querySelector('.ucv2-list-toggle-label');
      if (label) label.textContent = d.open ? 'Show fewer' : `Show all ${d.dataset.ucv2Total}`;
    });
  }
}

// ---- Continue Update, light and live (2026-10-23) ----
// Starts from what the last apply left unfinished and the groups, all re-checked against Vortex as it is now, instead
// of the full review. New words below need their Gemini pass.
const UCV2_NOTHING_LEFT = 'Nothing left to do.';
const UCV2_STILL_OPEN_HELP = 'The last update did not finish these. Check the whole collection to finish them.';

async function ucv2StartContinue(modId) {
  if (ucv2ActiveReviewModId !== null) return;
  ucv2ActiveReviewModId = modId;
  ucv2OptionalFlowActive = false;
  ucv2KeepRemovedModIds = new Set();
  ucv2UpdateReviewLockUI();
  ucv2HideCriticalError();
  ucv2ShowReviewLoadingSkeleton(modId);
  ucv2ShowReviewActivity(UCV2_LOADING_TEXT_ONE_COLLECTION);
  try {
    const answer = await ucv2Api('POST', '/api/update-collection-v2/continue-check', { collectionModId: modId, settle: true });
    if (answer && answer.legacy) {
      // An older record with no list of what was left: the full review runs once and writes the list this time.
      ucv2ActiveReviewModId = null;
      ucv2HideReviewActivity();
      return ucv2StartReview(modId);
    }
    ucv2CurrentReview = ucv2NormalizeReview(answer);
    ucv2CurrentReview.pictureUrl = ucv2Collections.find((c) => c.modId === modId)?.pictureUrl || null;
    ucv2CurrentReview.collectionSlug = ucv2Collections.find((c) => c.modId === modId)?.collectionSlug || null;
    ucv2RenderReviewScreen();
    ucv2GoScreen('ucv2Screen2');
  } catch (e) {
    ucv2ActiveReviewModId = null;
    ucv2UpdateReviewLockUI();
    ucv2GoScreen('ucv2Screen1');
    ucv2HandleError(e, () => ucv2StartContinue(modId));
  } finally {
    ucv2HideReviewActivity();
  }
}
window.ucv2StartContinue = ucv2StartContinue;

// Re-check the open Continue screen against Vortex as it is now (on coming back to the page): only the groups
// and the unfinished list, never the whole collection. Old result lines go with the old state.
let ucv2ContinueRecheckBusy = false;
async function ucv2RecheckContinueScreen() {
  const r = ucv2CurrentReview;
  if (!r || !r.continueOnly || ucv2ContinueRecheckBusy) return;
  ucv2ContinueRecheckBusy = true;
  try {
    const answer = await ucv2Api('POST', '/api/update-collection-v2/continue-check', { collectionModId: r.collectionModId });
    if (!answer || answer.legacy || !ucv2CurrentReview || !ucv2CurrentReview.continueOnly) return;
    const fresh = ucv2NormalizeReview(answer);
    fresh.pictureUrl = r.pictureUrl; fresh.collectionSlug = r.collectionSlug;
    ucv2CurrentReview = fresh;
    ucv2RenderContinueOnly(fresh);
  } catch (e) {
    // Best effort: the screen keeps what it has; the next return or button press checks again.
  } finally {
    ucv2ContinueRecheckBusy = false;
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ucv2RecheckContinueScreen(); });

function ucv2RenderContinueOnly(r) {
  $ucv2('ucv2ReviewTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  ucv2SetScreenHeadThumb('ucv2ReviewThumb', r.pictureUrl);
  for (const id of ['ucv2ReviewRenameNote', 'ucv2ReviewRevisionPicker', 'ucv2ReviewInstructions', 'ucv2ReviewNoChangesTip', 'ucv2ReviewFilterBadges', 'ucv2ReviewTableWrap', 'ucv2ApplyUpdateBtn', 'ucv2KeepSelectionBar']) {
    const el = $ucv2(id);
    if (el) el.classList.add('hidden');
  }
  const open = r.unfinished.length;
  const lead = $ucv2('ucv2ReviewLead');
  lead.classList.remove('hidden');
  lead.textContent = r.nothingLeft ? UCV2_NOTHING_LEFT
    : (open > 0 ? `${open} thing${open === 1 ? '' : 's'} left from the last update.` : '');
  ucv2RenderContinueGroups(r);
}

// The groups keep their own state (2026-10-23). A button only changes its own group: the mods that succeeded
// leave it, every other group stays exactly as it was, and the review is NOT run again (that re-reads the whole
// mod list and every download on a busy Vortex). New words below need their Gemini pass.
let ucv2ContinueState = null;
const UCV2_INCOMPLETE_WARNING = "Couldn't check every mod. Vortex didn't answer. Press Refresh to check again.";
const UCV2_OLD_DOWNLOADS_HELP = 'Vortex lists these old downloads again as Never Installed. This deletes each one\'s file and its entry. Nothing else is touched.';
const UCV2_PICKS_ONLY_HELP = 'These mods already have the new file. If you installed them again after the collection changed its install options, they already have the new options. This tells Vortex so, without installing anything again.';
const UCV2_CLEAR_ARROW_HELP = 'Vortex still thinks these mods have an update waiting, though they have the file the collection asks for. This tells Vortex they are up to date.';
const UCV2_REASON_TEXT = {
  unconfirmed: "Vortex didn't confirm this one.",
  'old-in-use': 'Another mod still uses its old download.',
  'own-copy': "This mod's own download is the same file, so its old download was left alone.",
  'in-progress': 'A download of the same file is still running.',
};

function ucv2RenderContinueGroups(r) {
  ucv2ContinueState = {
    collectionModId: r.collectionModId,
    finish: [...(r.finishDetails || [])],
    strays: [...(r.strayArchives || [])],
    oldDownloads: [...(r.oldDownloads || [])],
    unfinished: [...(r.unfinished || [])],
    picksOnly: [...(r.picksOnlyMods || [])],
    picksOnlyAll: [...(r.picksOnlyMods || [])],
    picksStatus: '',
    arrows: [...(r.staleArrows || [])],
    older: [...(r.olderInstalled || [])],
    arrowStatus: '',
    fileErrors: new Map(), // downloadId -> "Couldn't delete <file>: it is in use."
    oldStatus: '',
    dupes: r.duplicateCopies || [],
    incomplete: r.checksIncomplete || [],
    reasons: new Map(), // vortexModId -> reason code, for mods a button could not finish
    finishStatus: '',
    linkStatus: '',
  };
  ucv2DrawContinueGroups();
}

function ucv2DrawContinueGroups() {
  const st = ucv2ContinueState;
  const box = $ucv2('ucv2ReviewContinueGroups');
  if (!st) { box.innerHTML = ''; return; }
  const { finish, strays, dupes } = st;
  const old = st.oldDownloads;
  let html = '';
  if (st.incomplete.length > 0) {
    html += `<p style="color:var(--warning)">⚠️ ${escHtmlUcv2(UCV2_INCOMPLETE_WARNING)} <button type="button" class="btn btn--ghost btn--small" id="ucv2ContinueRefreshBtn">Refresh</button></p>`;
  }
  if (finish.length > 0) {
    html += `<div class="ucv2-continue-group"><h3>Finish saving details (${finish.length})</h3><p class="muted">${escHtmlUcv2(UCV2_FINISH_DETAILS_HELP)}</p>`
      + ucv2LimitedListHtml('finish', finish.map((f) => `<li>${escHtmlUcv2(f.mod.name)} ${escHtmlUcv2(f.was.version ?? '')} → ${escHtmlUcv2(f.mod.version ?? '')}</li>`))
      + `<button class="btn btn--primary btn--small" id="ucv2FinishDetailsBtn">Finish saving details</button> <span class="muted" id="ucv2FinishDetailsStatus">${escHtmlUcv2(st.finishStatus)}</span></div>`;
  } else if (st.incomplete.includes('finishDetails')) {
    html += '<div class="ucv2-continue-group"><h3>Finish saving details (not checked)</h3></div>';
  }
  if (st.unfinished.length > 0) {
    html += `<div class="ucv2-continue-group"><h3>Still open (${st.unfinished.length})</h3><p class="muted">${escHtmlUcv2(UCV2_STILL_OPEN_HELP)}</p>`
      + ucv2LimitedListHtml('unfinished', st.unfinished.map((o) => `<li>${escHtmlUcv2(o.name)}${o.error ? ` <span class="muted">— ${escHtmlUcv2(o.error)}</span>` : ''}</li>`))
      + '<button class="btn btn--primary btn--small" id="ucv2CheckWholeBtn">Check the whole collection</button></div>';
  }
  if (st.picksOnly.length > 0) {
    html += `<div class="ucv2-continue-group"><h3>Install options (${st.picksOnly.length})</h3><p class="muted">${escHtmlUcv2(UCV2_PICKS_ONLY_HELP)}</p>`
      + ucv2LimitedListHtml('picks', st.picksOnly.map((s) => `<li>${escHtmlUcv2(s.name)} ${escHtmlUcv2(s.version ?? '')}</li>`))
      + `<button class="btn btn--primary btn--small" id="ucv2ConfirmPicksBtn">They already have the new options</button> <span class="muted" id="ucv2ConfirmPicksStatus">${escHtmlUcv2(st.picksStatus)}</span></div>`;
  }
  if (st.older.length > 0) {
    html += `<div class="ucv2-continue-group"><p class="muted">${st.older.length} installed mod${st.older.length === 1 ? ' is' : 's are'} older than this collection lists.</p>`
      + ucv2LimitedListHtml('older', st.older.map((o) => `<li>${escHtmlUcv2(o.name)} ${escHtmlUcv2(o.installedVersion ?? '')} → ${escHtmlUcv2(o.listedVersion ?? '')}</li>`))
      + '<button class="btn btn--primary btn--small" id="ucv2UpdateOlderBtn">Update them</button></div>';
  }
  if (st.arrows.length > 0) {
    html += `<div class="ucv2-continue-group"><h3>Clear the update arrow (${st.arrows.length})</h3><p class="muted">${escHtmlUcv2(UCV2_CLEAR_ARROW_HELP)}</p>`
      + ucv2LimitedListHtml('arrows', st.arrows.map((s) => `<li>${escHtmlUcv2(s.name)} ${escHtmlUcv2(s.version ?? '')}</li>`))
      + `<button class="btn btn--primary btn--small" id="ucv2ClearArrowBtn">Clear the update arrow</button> <span class="muted" id="ucv2ClearArrowStatus">${escHtmlUcv2(st.arrowStatus)}</span></div>`;
  }
  if (strays.length > 0) {
    const reasonLines = strays.filter((s) => st.reasons.has(s.vortexModId))
      .map((s) => `<div class="muted" style="font-size:12px">${escHtmlUcv2(s.name)}: ${escHtmlUcv2(st.fileErrors.get(s.vortexModId) || UCV2_REASON_TEXT[st.reasons.get(s.vortexModId)] || UCV2_REASON_TEXT.unconfirmed)}</div>`).join('');
    html += `<div class="ucv2-continue-group"><h3>Link its new download (${strays.length})</h3><p class="muted">${escHtmlUcv2(UCV2_LINK_DOWNLOADS_HELP)}</p>`
      + ucv2LimitedListHtml('strays', strays.map((s) => `<li>${escHtmlUcv2(s.name)} ${escHtmlUcv2(s.version ?? '')}</li>`))
      + reasonLines
      + `<button class="btn btn--primary btn--small" id="ucv2LinkDownloadsBtn">Link its new download</button> <span class="muted" id="ucv2LinkDownloadsStatus">${escHtmlUcv2(st.linkStatus)}</span></div>`;
  } else if (st.incomplete.includes('strayArchives')) {
    html += '<div class="ucv2-continue-group"><h3>Link its new download (not checked)</h3></div>';
  }
  if (old.length > 0) {
    const fileErrors = old.filter((o) => st.reasons.has(o.downloadId) && st.fileErrors.has(o.downloadId))
      .map((o) => `<div class="muted" style="font-size:12px">${escHtmlUcv2(o.name)}: ${escHtmlUcv2(st.fileErrors.get(o.downloadId))}</div>`).join('');
    const reasonLines = old.filter((o) => st.reasons.has(o.downloadId) && !st.fileErrors.has(o.downloadId))
      .map((o) => `<div class="muted" style="font-size:12px">${escHtmlUcv2(o.name)}: ${escHtmlUcv2(UCV2_REASON_TEXT[st.reasons.get(o.downloadId)] || UCV2_REASON_TEXT.unconfirmed)}</div>`).join('');
    html += `<div class="ucv2-continue-group"><h3>Remove its old download (${old.length})</h3><p class="muted">${escHtmlUcv2(UCV2_OLD_DOWNLOADS_HELP)}</p>`
      + ucv2LimitedListHtml('oldDl', old.map((o) => `<li>${escHtmlUcv2(o.name)} ${escHtmlUcv2(o.version ?? '')}</li>`))
      + fileErrors + reasonLines
      + `<button class="btn btn--primary btn--small" id="ucv2RemoveOldBtn">Remove its old download</button> <span class="muted" id="ucv2RemoveOldStatus">${escHtmlUcv2(st.oldStatus)}</span></div>`;
  } else if (st.incomplete.includes('oldDownloads')) {
    html += '<div class="ucv2-continue-group"><h3>Remove its old download (not checked)</h3></div>';
  }
  if (dupes.length > 0) {
    html += `<div class="ucv2-continue-group"><h3>Duplicate copies (${dupes.length})</h3><p class="muted">${escHtmlUcv2(UCV2_DUPLICATES_HELP)}</p>`
      + ucv2LimitedListHtml('dupes', dupes.map((g) => `<li>${g.map((c) => `${escHtmlUcv2(c.name)} ${escHtmlUcv2(c.version ?? '')} (${c.hasFiles ? 'has the files' : 'no files'})`).join(' and ')}</li>`)) + '</div>';
  }
  box.innerHTML = html;
  ucv2WireLimitedLists(box);

  const refreshBtn = document.getElementById('ucv2ContinueRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      // On the Continue screen Refresh checks the groups again (light); on a full review it restarts the review.
      if (ucv2CurrentReview && ucv2CurrentReview.continueOnly) { ucv2RecheckContinueScreen(); return; }
      ucv2ActiveReviewModId = null; ucv2StartReview(st.collectionModId);
    });
  }

  const btn = document.getElementById('ucv2FinishDetailsBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      $ucv2('ucv2FinishDetailsStatus').textContent = 'Saving…';
      try {
        const out = await ucv2Api('POST', '/api/update-collection-v2/finish-details', { collectionModId: st.collectionModId, vortexModIds: st.finish.map((f) => f.vortexModId) });
        const done = new Set((out.results || []).filter((x) => x.ok).map((x) => x.vortexModId));
        st.finish = st.finish.filter((f) => !done.has(f.vortexModId));
        const bad = st.finish.length;
        st.finishStatus = bad ? `${bad} didn't save. Try again.` : '';
      } catch (e) {
        st.finishStatus = "Couldn't save. Try again.";
      }
      ucv2DrawContinueGroups(); // only the groups; the other groups and the table stay as they are
    });
  }
  const checkWholeBtn = document.getElementById('ucv2CheckWholeBtn');
  if (checkWholeBtn) {
    // The one place the whole collection is checked from Continue Update: only when the person asks for it.
    checkWholeBtn.addEventListener('click', () => { ucv2ActiveReviewModId = null; ucv2CurrentReview = null; ucv2StartReview(st.collectionModId); });
  }
  const updateOlderBtn = document.getElementById('ucv2UpdateOlderBtn');
  if (updateOlderBtn) {
    // They join the Updated list below (same rows, same Apply); the server adds the same ones when it re-checks.
    updateOlderBtn.addEventListener('click', () => {
      const r = ucv2CurrentReview;
      if (!r || r.continueOnly) return;
      r.updated = [...r.updated, ...st.older.map((o) => o.pair)];
      r.olderInstalled = [];
      r.olderIncluded = true;
      ucv2RenderReviewScreen();
    });
  }
  const confirmPicksBtn = document.getElementById('ucv2ConfirmPicksBtn');
  if (confirmPicksBtn) {
    confirmPicksBtn.addEventListener('click', async () => {
      confirmPicksBtn.disabled = true;
      $ucv2('ucv2ConfirmPicksStatus').textContent = 'Saving…';
      try {
        const out = await ucv2Api('POST', '/api/update-collection-v2/confirm-new-options', { collectionModId: st.collectionModId, vortexModIds: st.picksOnly.map((s) => s.vortexModId) });
        const done = new Set((out.results || []).filter((x) => x.ok).map((x) => x.vortexModId));
        st.picksOnly = st.picksOnly.filter((s) => !done.has(s.vortexModId));
        st.picksStatus = st.picksOnly.length > 0 ? `${st.picksOnly.length} didn't save. Try again.` : '';
        // The rows of the mods that are done leave the table too (nothing is installed again for them).
        const r = ucv2CurrentReview;
        if (r && !r.continueOnly) {
          const doneKeys = new Set(st.picksOnlyAll.filter((s) => done.has(s.vortexModId)).map((s) => s.name));
          r.updated = r.updated.filter((u) => !(u.fileAlreadyNew && doneKeys.has(u.new.name)));
          r.picksOnlyMods = st.picksOnly;
          if (st.picksOnly.length === 0 || done.size > 0) {
            const keep = st.picksStatus;
            ucv2RenderReviewScreen();
            if (ucv2ContinueState) { ucv2ContinueState.picksStatus = keep; ucv2DrawContinueGroups(); }
            return;
          }
        }
      } catch (e) {
        st.picksStatus = "Couldn't save. Try again.";
      }
      ucv2DrawContinueGroups();
    });
  }
  const clearArrowBtn = document.getElementById('ucv2ClearArrowBtn');
  if (clearArrowBtn) {
    clearArrowBtn.addEventListener('click', async () => {
      clearArrowBtn.disabled = true;
      $ucv2('ucv2ClearArrowStatus').textContent = 'Clearing…';
      try {
        const out = await ucv2Api('POST', '/api/update-collection-v2/clear-update-arrow', { collectionModId: st.collectionModId, vortexModIds: st.arrows.map((s) => s.vortexModId) });
        const done = new Set((out.results || []).filter((x) => x.ok).map((x) => x.vortexModId));
        st.arrows = st.arrows.filter((s) => !done.has(s.vortexModId));
        st.arrowStatus = st.arrows.length > 0 ? `${st.arrows.length} didn't clear. Try again.` : '';
      } catch (e) {
        st.arrowStatus = "Couldn't clear. Try again.";
      }
      ucv2DrawContinueGroups();
    });
  }
  const removeOldBtn = document.getElementById('ucv2RemoveOldBtn');
  if (removeOldBtn) {
    removeOldBtn.addEventListener('click', async () => {
      removeOldBtn.disabled = true;
      $ucv2('ucv2RemoveOldStatus').textContent = 'Removing…';
      try {
        const out = await ucv2Api('POST', '/api/update-collection-v2/remove-old-downloads', { downloadIds: st.oldDownloads.map((o) => o.downloadId) });
        const results = out.results || [];
        const done = new Set(results.filter((x) => x.ok).map((x) => x.downloadId));
        for (const x of results) {
          if (done.has(x.downloadId)) continue;
          st.reasons.set(x.downloadId, x.reason || 'unconfirmed');
          if (x.fileError) st.fileErrors.set(x.downloadId, x.fileError);
        }
        const before = st.oldDownloads.length;
        st.oldDownloads = st.oldDownloads.filter((o) => !done.has(o.downloadId));
        st.oldStatus = st.oldDownloads.length > 0 ? `${before - st.oldDownloads.length} removed. ${st.oldDownloads.length} left.` : '';
      } catch (e) {
        st.oldStatus = "Couldn't remove. Try again.";
      }
      ucv2DrawContinueGroups();
    });
  }
  const linkBtn = document.getElementById('ucv2LinkDownloadsBtn');
  if (linkBtn) {
    linkBtn.addEventListener('click', async () => {
      linkBtn.disabled = true;
      $ucv2('ucv2LinkDownloadsStatus').textContent = 'Linking…';
      try {
        const out = await ucv2Api('POST', '/api/update-collection-v2/link-downloads', { collectionModId: st.collectionModId, vortexModIds: st.strays.map((s) => s.vortexModId) });
        const results = out.results || [];
        const linked = new Set(results.filter((x) => x.ok && x.oneEntry).map((x) => x.vortexModId));
        for (const x of results) {
          if (!linked.has(x.vortexModId)) st.reasons.set(x.vortexModId, x.reason || 'unconfirmed');
          if (x.fileError) st.fileErrors.set(x.vortexModId, x.fileError);
        }
        const fileErrs = results.filter((x) => x.fileError).length;
        const before = st.strays.length;
        st.strays = st.strays.filter((s) => !linked.has(s.vortexModId));
        st.linkStatus = (st.strays.length > 0 ? `${before - st.strays.length} linked. ${st.strays.length} still show twice.` : '')
          + (fileErrs > 0 ? ` ${fileErrs} old file${fileErrs === 1 ? '' : 's'} couldn't be deleted: in use.` : '');
      } catch (e) {
        st.linkStatus = "Couldn't link. Try again.";
      }
      ucv2DrawContinueGroups();
    });
  }
}

function ucv2RevisionLabel() {
  const r = ucv2CurrentReview;
  // A Continue Update after a run that already moved the collection's record to the new revision: the
  // old "from" number is gone (it would read "Rev 118 → Rev 118"), so say what is happening instead.
  if (r.continuing && r.previousRevision == null) return `Finishing Rev ${r.newRevisionNumber ?? '?'}`;
  if (r.continuing) return `Rev ${r.previousRevision} → Rev ${r.newRevisionNumber ?? '?'}`;
  return `Rev ${r.installedRevision ?? '?'} → Rev ${r.newRevisionNumber ?? '?'}`;
}

// Revision picker (2026-08-27) -- director's own spec, two real Nexus screenshots as reference: a
// right-justified dropdown on the title line listing every revision from what's installed up to the
// newest (review.revisions, already filtered server-side -- see resolveReviewRevisions in
// lib/update-collection-v2-runner.js), for deliberately updating to an OLDER available revision
// instead of always following the newest (a newer one can break a mod list). Same date format as the
// existing Workshop-only revision dropdown (web/public/app.js's lookupRevisions) -- updatedAt, not
// createdAt, for the same reason that one already documents: Nexus updates a draft/unlisted
// revision's content in place rather than bumping revisionNumber, so createdAt can read stale.
//
// RESTYLED (2026-08-27, director's own addendum, a real Nexus screenshot as reference) -- a plain
// <select>'s <option> is text-only in every browser, so Nexus's own real two-line-per-row layout
// needs a genuine custom component instead: a button trigger + an absolutely-positioned scrollable
// panel, built/torn down here rather than native <select> markup.
//
// DATA GAP (confirmed via real GraphQL introspection against Nexus's own API, not guessed): the
// query behind review.revisions (fetchCollectionRevisions' publicRevisions) resolves to
// PublicCollectionRevision, which only exposes revisionNumber/revisionStatus/createdAt/updatedAt
// (+ id/discardedAt/overallRating/collectionChangelog) -- file size, game version, and the
// adult-content flag all exist ONLY on the separate, singular CollectionRevision type (reachable one
// revision at a time), which would mean one extra GraphQL round trip PER revision shown just to
// populate this dropdown. Deliberately not paying that cost by default -- this shows revision number
// + date only, not Nexus's own full four-field row.

// At most one picker open at a time (only one of the two screens is ever visible anyway) -- lets a
// single shared document-level click listener close whichever one is open, rather than each render
// wiring its own outside-click handler.
let ucv2RevPickerOpenId = null;
function ucv2CloseRevisionPicker() {
  if (!ucv2RevPickerOpenId) return;
  const el = document.getElementById(ucv2RevPickerOpenId);
  if (el) {
    el.classList.remove('ucv2-rev-picker--open');
    const panel = el.querySelector('.ucv2-rev-picker__panel');
    if (panel) panel.remove();
  }
  ucv2RevPickerOpenId = null;
}
document.addEventListener('click', (e) => {
  if (!ucv2RevPickerOpenId) return;
  const el = document.getElementById(ucv2RevPickerOpenId);
  if (el && !el.contains(e.target)) ucv2CloseRevisionPicker();
});

// Nexus's own real revision picker shows file size and game version on every row, plus a red
// "Adult" tag on adult-content revisions (director's own follow-up, 2026-08-28). Those fields only
// exist on the singular collectionRevision(slug, revision) GraphQL type, not the list query the
// base revisions array comes from -- lib/nexus-collection-download.js's fetchRevisionsRichness
// fetches them via one aliased query and merges them in server-side, so here they're just plain
// (possibly-absent) properties on each rev -- degrade gracefully, never show a placeholder for a
// missing one.
function ucv2FormatBytes(n) {
  if (n === null || n === undefined || n === '') return '';
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '';
  const mb = num / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(num / 1024))} KB`;
}

// Shared two-line content (Nexus's own real shape) used by BOTH the collapsed trigger's single
// selected-revision display and every row in the expanded panel.
function ucv2RevisionContentHtml(rev) {
  const when = new Date(rev.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const size = ucv2FormatBytes(rev.fileSize);
  const adultTag = rev.adultContent ? '<span class="ucv2-rev-picker__adult-tag">Adult</span>' : '';
  const gameVersions = Array.isArray(rev.gameVersions) && rev.gameVersions.length
    ? `Game version ${escHtmlUcv2(rev.gameVersions.join(" or "))}` : '';
  return `<div class="ucv2-rev-picker__line">`
    + `<span class="ucv2-rev-picker__num">Revision ${rev.revisionNumber}${adultTag}</span>`
    + (size ? `<span class="ucv2-rev-picker__size">${size}</span>` : '')
    + `</div>`
    + `<div class="ucv2-rev-picker__line">`
    + (gameVersions ? `<span class="ucv2-rev-picker__gameversion">${gameVersions}</span>` : '<span></span>')
    + `<span class="ucv2-rev-picker__date">${when}</span></div>`;
}

function ucv2RevisionPickerRowsHtml() {
  const r = ucv2CurrentReview;
  return (r.revisions || []).map((rev) => {
    const selected = rev.revisionNumber === r.newRevisionNumber;
    return `<button type="button" class="ucv2-rev-picker__row${selected ? ' ucv2-rev-picker__row--selected' : ''}" data-rev="${rev.revisionNumber}">`
      + ucv2RevisionContentHtml(rev) + `</button>`;
  }).join('');
}

// Shared by both screens (containerId differs, screenId tells ucv2PickRevision which render function
// to call back into). Stays pickable across as many picks as the director wants on the SAME screen
// (2026-08-28, director's own real ask: "fix the drop-down revision to not disappear until we hit
// continue -- that way I could see the files being removed for different revisions" -- previously
// hidden after the FIRST pick, "one pick per review session"). Only ever hidden when there's genuinely
// nothing to pick from.
function ucv2RenderRevisionPicker(containerId, screenId) {
  const container = $ucv2(containerId);
  const r = ucv2CurrentReview;
  ucv2CloseRevisionPicker();
  if (!r || !r.revisions || r.revisions.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  const current = r.revisions.find((rev) => rev.revisionNumber === r.newRevisionNumber);
  container.classList.remove('hidden');
  container.innerHTML = `<button type="button" class="ucv2-rev-picker__trigger">`
    + `<span class="ucv2-rev-picker__trigger-text">${current ? ucv2RevisionContentHtml(current) : `Revision ${r.newRevisionNumber ?? '?'}`}</span>`
    + `<span class="ucv2-rev-picker__chevron">▾</span></button>`;
  container.querySelector('.ucv2-rev-picker__trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = container.classList.contains('ucv2-rev-picker--open');
    ucv2CloseRevisionPicker();
    if (wasOpen) return; // this click just closed it
    container.classList.add('ucv2-rev-picker--open');
    ucv2RevPickerOpenId = containerId;
    const panel = document.createElement('div');
    panel.className = 'ucv2-rev-picker__panel';
    panel.innerHTML = ucv2RevisionPickerRowsHtml();
    panel.querySelectorAll('.ucv2-rev-picker__row').forEach((row) => {
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ucv2CloseRevisionPicker();
        ucv2PickRevision(Number(row.dataset.rev), screenId);
      });
    });
    container.appendChild(panel);
  });
}

// Re-reviews against a specific, director-picked revision instead of the newest -- same review
// endpoint, just with targetRevisionNumber set. Re-renders WHICHEVER screen the picker was on
// (Removed or Review), deliberately skipping ucv2StartReview's own initial screen-choice branching
// (removed.length > 0 ? Removed : Review) -- the director is already looking at one of the two
// screens and picking a revision doesn't change which KIND of screen that is, even if the picked
// revision's own removed list comes back empty.
async function ucv2PickRevision(revisionNumber, screenId) {
  if (!ucv2CurrentReview || ucv2ActiveReviewModId === null) return;
  const modId = ucv2ActiveReviewModId;
  ucv2HideCriticalError();
  ucv2ShowReviewActivity(UCV2_LOADING_TEXT_ONE_COLLECTION);
  // Disabled for the duration of the re-fetch -- otherwise a click here races the in-flight request,
  // acting on the OLD (about-to-be-replaced) ucv2CurrentReview data. Both buttons disabled
  // regardless of which screen is actually visible right now (same "don't need to know/care which
  // one" reasoning as ucv2ShowReviewActivity above). Re-enabled below regardless of outcome (success
  // re-renders with fresh data; failure falls back to re-rendering the still-valid OLD data, which
  // is clickable again too).
  $ucv2('ucv2ApplyUpdateBtn').disabled = true;
  $ucv2('ucv2RemovedContinueBtn').disabled = true;
  try {
    const review = await ucv2RunReviewRequest({ collectionModId: modId, targetRevisionNumber: revisionNumber }, ucv2ShowReviewActivity);
    ucv2CurrentReview = ucv2NormalizeReview(review);
    // Same pictureUrl/collectionSlug carry-forward as ucv2StartReview's own initial fetch -- the
    // review response itself has neither, and it's still the exact same collection.
    ucv2CurrentReview.pictureUrl = ucv2Collections.find((c) => c.modId === modId)?.pictureUrl || null;
    ucv2CurrentReview.collectionSlug = ucv2Collections.find((c) => c.modId === modId)?.collectionSlug || null;
    if (screenId === 'ucv2ScreenRemoved') ucv2RenderRemovedScreen(); else ucv2RenderReviewScreen();
    ucv2GoScreen(screenId);
  } catch (e) {
    // Failed -- give the dropdown back rather than leaving the director stuck with no way to retry
    // the pick (or fall back to Cancel/Back, the only other escape hatch).
    ucv2HandleError(e, () => ucv2PickRevision(revisionNumber, screenId));
    if (screenId === 'ucv2ScreenRemoved') ucv2RenderRemovedScreen(false); else ucv2RenderReviewScreen();
  } finally {
    ucv2HideReviewActivity();
    $ucv2('ucv2ApplyUpdateBtn').disabled = false;
    $ucv2('ucv2RemovedContinueBtn').disabled = false;
  }
}

// Game version mismatch (2026-08-27, director's own request) -- the SAME real warning Vortex itself
// shows (InstallDriver.ts, confirmed via source: "The version of the game you have installed is
// different to the one the curator used..."), shown right when a review actually starts, before the
// diff renders (ucv2StartReview below), whenever review.gameVersionMismatch.mismatch is true. Resolves
// to `true` (Continue -- proceed into the normal review flow) or `false` (Cancel -- back to the
// collections list, exactly like Vortex's own real dialog). One listener pair per call rather than a
// persistent one -- this modal only ever shows once per review start, so a fresh, cleanly-removed
// listener each time is simpler than guarding against a stale one firing twice.
function ucv2ShowGameVersionMismatchModal(actual, intended) {
  return new Promise((resolve) => {
    $ucv2('ucv2GameVersionActual').textContent = actual;
    $ucv2('ucv2GameVersionIntended').textContent = intended;
    const modal = $ucv2('ucv2GameVersionMismatchModal');
    const cancelBtn = $ucv2('ucv2GameVersionCancelBtn');
    const continueBtn = $ucv2('ucv2GameVersionContinueBtn');
    const cleanup = () => {
      modal.classList.add('hidden');
      cancelBtn.removeEventListener('click', onCancel);
      continueBtn.removeEventListener('click', onContinue);
    };
    const onCancel = () => { cleanup(); resolve(false); };
    const onContinue = () => { cleanup(); resolve(true); };
    cancelBtn.addEventListener('click', onCancel);
    continueBtn.addEventListener('click', onContinue);
    modal.classList.remove('hidden');
  });
}

// Loading skeleton (2026-08-30, director's own layout call) -- page 1 stays a plain "Refresh"
// action; the moment a real review starts, we move straight to the Review screen's own layout (even
// though we don't have real data yet -- the destination could turn out to be ucv2ScreenRemoved
// instead once data arrives, see ucv2StartReview's own final render below) so the activity line has
// its real home (left-justified, same row as Back/Apply update) instead of nowhere. Only the
// header (name/thumb, from the picker's own cached collection list) and the activity line are real;
// everything else from a genuine review (instructions, the diff table, filter pills) is hidden until
// ucv2RenderReviewScreen/ucv2RenderRemovedScreen overwrite this skeleton with the real result.
function ucv2ShowReviewLoadingSkeleton(modId) {
  const c = ucv2Collections.find((col) => col.modId === modId);
  $ucv2('ucv2ReviewTitle').textContent = c ? c.name : 'Loading…';
  ucv2SetScreenHeadThumb('ucv2ReviewThumb', c ? c.pictureUrl : null);
  $ucv2('ucv2ReviewViewOnNexusBtn').classList.add('hidden');
  $ucv2('ucv2ReviewRevisionPicker').classList.add('hidden');
  $ucv2('ucv2ReviewInstructions').classList.add('hidden');
  $ucv2('ucv2ReviewLead').classList.add('hidden');
  $ucv2('ucv2ReviewNoChangesTip').classList.add('hidden');
  $ucv2('ucv2ReviewEmpty').classList.add('hidden');
  $ucv2('ucv2ReviewFilterBadges').classList.add('hidden');
  $ucv2('ucv2ReviewTableBody').innerHTML = '';
  $ucv2('ucv2KeepSelectionBar').classList.add('hidden');
  $ucv2('ucv2ApplyUpdateBtn').disabled = true;
  ucv2GoScreen('ucv2Screen2');
}

async function ucv2StartReview(modId) {
  if (ucv2ActiveReviewModId !== null) return; // button should already be disabled -- guard anyway
  ucv2ActiveReviewModId = modId;
  ucv2OptionalFlowActive = false;
  ucv2GapsFixedForActiveReview = false;
  ucv2KeepRemovedModIds = new Set();
  ucv2DeleteArchives = true;
  $ucv2('ucv2DeleteArchivesCheckbox').checked = true;
  ucv2FomodPicks = {};
  ucv2IgnoreFomodValidationModIds = new Set();
  ucv2IgnoredDependencyBreakKeys = new Set();
  ucv2UpdateReviewLockUI();
  ucv2HideCriticalError();
  ucv2ShowReviewLoadingSkeleton(modId);
  ucv2ShowReviewActivity(UCV2_LOADING_TEXT_ONE_COLLECTION);
  try {
    const review = await ucv2RunReviewRequest({ collectionModId: modId }, ucv2ShowReviewActivity);
    ucv2CurrentReview = ucv2NormalizeReview(review);
    // The review response has no image of its own -- reuse the collection's own cached pictureUrl
    // (populated by the Refresh cache, see update-collection-auto-check-for-images) rather than a
    // second fetch, since it's the exact same collection this review is for.
    ucv2CurrentReview.pictureUrl = ucv2Collections.find((c) => c.modId === modId)?.pictureUrl || null;
    // Same reasoning as pictureUrl above -- the review response has no Nexus slug of its own, reuse
    // the already-loaded collection list's own cached copy for the "View on Nexus" button. The
    // revision number, though, comes straight from the review response itself
    // (review.newRevisionNumber) -- the CURRENT/updated revision being reviewed, not the collection
    // list's own stale installedRevision (director's own call, 2026-08-26: the Nexus link should land
    // on the revision you're actually looking at here, not the one still installed).
    ucv2CurrentReview.collectionSlug = ucv2Collections.find((c) => c.modId === modId)?.collectionSlug || null;
    // Game version mismatch (2026-08-27) -- shown right here, before the diff renders, matching
    // Vortex's own real timing exactly (InstallDriver.ts shows this at the same point, right when an
    // install/update actually starts). Activity hidden first -- the modal itself IS the "waiting on a
    // real decision" state now, not a background fetch.
    if (review.gameVersionMismatch && review.gameVersionMismatch.mismatch) {
      ucv2HideReviewActivity();
      const proceed = await ucv2ShowGameVersionMismatchModal(review.gameVersionMismatch.actual, review.gameVersionMismatch.intended);
      if (!proceed) {
        // Cancel -- back to the collections list, exactly like Vortex's own real dialog.
        ucv2ActiveReviewModId = null;
        ucv2CurrentReview = null;
        ucv2UpdateReviewLockUI();
        ucv2GoScreen('ucv2Screen1');
        return;
      }
    }
    $ucv2('ucv2ApplyUpdateBtn').disabled = false;
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
    ucv2GoScreen('ucv2Screen1'); // undo the loading skeleton's own pre-navigation -- back to the picker
    ucv2HandleError(e, () => ucv2StartReview(modId));
  } finally {
    ucv2HideReviewActivity();
  }
}
window.ucv2StartReview = ucv2StartReview;

function ucv2ReleaseReview(modId, keepalive) {
  try {
    fetch('/api/update-collection-v2/review/release', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionModId: modId }), keepalive: !!keepalive,
    }).catch(() => {});
  } catch { /* best effort */ }
}
if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => { if (ucv2ActiveReviewModId && !ucv2ApplyEventSource && !ucv2DeployInFlight) ucv2ReleaseReview(ucv2ActiveReviewModId, true); });

function ucv2CancelReview() {
  // Mid-operation guard ("coming back from another tool starts clean", 2026-09-17): a real Apply or
  // Deploy still genuinely running (ucv2ApplyEventSource open, or ucv2DeployInFlight) must keep
  // running in view when the user comes back or clicks Back -- resetting here would strand its own
  // progress/result reporting. ucv2ApplyResultBackBtn is already disabled for the duration of a real
  // deploy (ucv2UpdateDeployBanner's own toggle), but ucv2ResetOnEntry (arriving from elsewhere) has
  // no such button to gate it, so the check lives here instead, covering both callers. Can't be
  // reached mid-apply via the Review screen's own Cancel/Back -- ucv2ConfirmApply already navigates
  // away to the dedicated Apply Progress screen before the apply's own stream even opens.
  if (ucv2ApplyEventSource || ucv2DeployInFlight) return;
  // Leaving the review: the server forgets the review it kept for this collection.
  if (ucv2ActiveReviewModId) ucv2ReleaseReview(ucv2ActiveReviewModId);
  ucv2ActiveReviewModId = null;
  ucv2CurrentReview = null;
  ucv2OptionalFlowActive = false;
  ucv2IgnoredDependencyBreakKeys = new Set();
  ucv2UpdateReviewLockUI();
  // Screen 2's own action row (Apply/Cancel) resets back to its pre-apply state -- the apply-result
  // screen itself is fully repopulated fresh by ucv2RenderApplyResult on the next apply, so there's
  // nothing stale to clear here beyond this.
  ucv2SetReviewActionsVisible(true);
  ucv2SetApplyBtnState(false, 'Apply Update →');
  ucv2SetCancelBtnText('Back');
  ucv2GoScreen('ucv2Screen1');
  // A real apply may have changed what's installed -- always reload fresh rather than show a
  // possibly-stale pre-apply collections list.
  ucv2LoadCollections();
}
$ucv2('ucv2RemovedBackBtn').addEventListener('click', ucv2CancelReview);

// Full reset back to "Pick a collection" -- fires only when the user arrives at this area from
// somewhere ELSE (shell.js's own previousArea check, same convention as Merge Plugins' own
// entry-refresh), never on internal step navigation within this tool. Confirmed real, 2026-08-26:
// without this, leaving mid-review for the home menu and coming back landed right back on whatever
// screen/review was left behind (even a stale Removed/Review table) instead of a fresh start.
// Reuses ucv2CancelReview's own reset -- it already clears the active review, resets the stepper/
// screen to ucv2Screen1, and reloads the collections list -- plus the leftover Keep-installed and
// removed-mods selection state ucv2CancelReview alone doesn't touch (only ucv2StartReview normally
// reseeds those, which never runs again until a fresh Review update click).
// ---- Opening Update Collection: wait patiently for a slow Vortex (2026-10-24) ----
// Vortex answers on one thread and can pause for seconds (memory clean-up), so a /health call that should take a few
// milliseconds sometimes takes 2 to 3 seconds. The first check used to give up after two 4 second tries and say Vortex was
// busy. Now the page opens at once with a "Checking Vortex…" line and keeps asking (10 second tries, about 45 seconds in all).
// New words below need their Gemini pass.
const UCV2_CHECKING_VORTEX = 'Checking Vortex…';
const UCV2_WAITING_VORTEX = 'Waiting for Vortex to answer…';
const UCV2_VORTEX_SLOW_LINE = 'Vortex is slow right now. Restarting Vortex usually fixes it.';
const UCV2_VORTEX_BUSY_BODY = "Vortex didn't answer in time. Wait a moment, then try again.";
const UCV2_VORTEX_WAIT_TOTAL_MS = 45000;
const UCV2_VORTEX_SLOW_AFTER_MS = 10000;

// probe() -> { state: 'ok' | 'refused' | 'timeout' | 'other' } (one try of up to 10 s). Resolves to
// { state, waitedMs, attempts }: 'ok' as soon as one answers, 'refused'/'other' at once (Vortex is closed or the Bridge is
// not there: waiting will not help), 'timeout' only after the whole wait.
async function ucv2WaitForVortex({ probe, sleep, now, totalMs = UCV2_VORTEX_WAIT_TOTAL_MS, onWaiting, onSlow }) {
  const started = now();
  let attempts = 0;
  let slowShown = false;
  for (;;) {
    attempts += 1;
    const answer = await probe();
    const waitedMs = now() - started;
    if (waitedMs > UCV2_VORTEX_SLOW_AFTER_MS && !slowShown) { slowShown = true; if (onSlow) onSlow(waitedMs); }
    if (answer.state === 'ok' || answer.state === 'refused' || answer.state === 'other') return { state: answer.state, waitedMs, attempts };
    if (waitedMs >= totalMs) return { state: 'timeout', waitedMs, attempts };
    if (attempts === 1 && onWaiting) onWaiting();
    await sleep(1000 + Math.floor(Math.random() * 1000));
  }
}

function ucv2SetSlowVortexLine(show) {
  const el = $ucv2('ucv2SlowVortexLine');
  if (!el) return;
  el.textContent = show ? '⚠️ ' + UCV2_VORTEX_SLOW_LINE : '';
  el.classList.toggle('hidden', !show);
}

// Called when Update Collection is opened. The tile already switched to this page; this is where the waiting happens.
async function ucv2EnterAfterVortexCheck() {
  ucv2HideCriticalError();
  ucv2SetSlowVortexLine(false);
  ucv2ShowLoading(UCV2_CHECKING_VORTEX);
  const result = await ucv2WaitForVortex({
    probe: () => ucv2Api('GET', '/api/update-collection-v2-bridge-probe').catch(() => ({ state: 'timeout' })),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    onWaiting: () => ucv2ShowLoading(UCV2_WAITING_VORTEX),
    onSlow: () => ucv2SetSlowVortexLine(true),
  });
  if (result.state === 'ok') {
    ucv2SetSlowVortexLine(result.waitedMs > UCV2_VORTEX_SLOW_AFTER_MS);
    ucv2CheckForUpdates();
    return;
  }
  $ucv2('ucv2Loading').classList.add('hidden');
  if (result.state === 'timeout') {
    ucv2Api('POST', '/api/update-collection-v2-bridge-probe/gave-up', { waitedMs: result.waitedMs, attempts: result.attempts }).catch(() => {}); // one log line on the server
    // Waited the whole time: the existing "Vortex is busy" message with its Try again button.
    window.showVortexRunningModal(ucv2EnterAfterVortexCheck, { title: '⚠️ Vortex is currently busy', body: UCV2_VORTEX_BUSY_BODY });
    return;
  }
  // Vortex is closed or the Bridge is not installed: nothing to wait for. Classic needs no Bridge (as the tile used to decide).
  ucv2SetSlowVortexLine(false);
  if (window.navigateToArea) window.navigateToArea('sync');
}

function ucv2ResetOnEntry() {
  ucv2KeepInstalledModIds = new Set();
  ucv2KeepRemovedModIds = new Set();
  ucv2DeleteArchives = true;
  $ucv2('ucv2DeleteArchivesCheckbox').checked = true;
  ucv2FomodPicks = {};
  ucv2IgnoreFomodValidationModIds = new Set();
  ucv2IgnoredDependencyBreakKeys = new Set();
  ucv2CancelReview();
  // Real Refresh (2026-08-28, director's own explicit rule: "anytime we leave the tool and come
  // back to it, should start on the home page with an automatic refresh -- the only time I should
  // have to hit refresh is if I'm in the tool and never leave it, but I've changed something in
  // Vortex") -- ucv2CancelReview's own ucv2LoadCollections() just above is a plain cache read, the
  // same one every OTHER internal reset (e.g. the Removed screen's own Back button) already uses on
  // purpose to stay lightweight. This is the one real "arriving from outside" entry point (never
  // fires on internal step navigation -- see this function's own header comment), so it alone gets
  // a genuine fresh check, layered on top rather than replacing the cache read above (that read
  // still renders instantly while this one is in flight, instead of a blank grid).
  ucv2EnterAfterVortexCheck();
}
window.ucv2ResetOnEntry = ucv2ResetOnEntry;
// Review screen's own Back -- goes to the Remove screen (preserving whatever keep/remove choices
// were already made there, see ucv2RenderRemovedScreen's own reseed param) when this review actually
// had one, otherwise all the way back to Collections same as before (director's own real report,
// 2026-08-26: "the back button on the review page takes me back to collections, not back to the
// remove page if there is one").
function ucv2ReviewBackClicked() {
  if ((ucv2CurrentReview?.removed?.length || 0) > 0) {
    ucv2RenderRemovedScreen(false);
    ucv2GoScreen('ucv2ScreenRemoved');
    return;
  }
  ucv2CancelReview();
}
$ucv2('ucv2CancelReviewBtn').addEventListener('click', ucv2ReviewBackClicked);
$ucv2('ucv2ApplyResultBackBtn').addEventListener('click', ucv2CancelReview);

// ONE Apply/Cancel row now (2026-08-26, replacing the old top+bottom duplication) -- a long mod list
// stays reachable via the table's own bounded scroll box instead, see this row's own HTML comment.
function ucv2SetApplyBtnState(disabled, text) {
  const btn = $ucv2('ucv2ApplyUpdateBtn');
  btn.disabled = disabled;
  if (text !== undefined) btn.textContent = text;
}
function ucv2SetCancelBtnText(text) {
  $ucv2('ucv2CancelReviewBtn').textContent = text;
}
function ucv2SetReviewActionsVisible(visible) {
  $ucv2('ucv2ReviewActions').classList.toggle('hidden', !visible);
}

function ucv2UpdateRemKeepCount() {
  const total = (ucv2CurrentReview?.removed || []).length;
  const n = ucv2KeepRemovedModIds.size;
  $ucv2('ucv2RemKeepCount').textContent = total ? `${n} of ${total} kept` : '';
}

function ucv2SyncRemKeepCheckboxes() {
  document.querySelectorAll('#ucv2RemovedList input[data-ucv2-remkeep-modid]').forEach((cb) => {
    cb.checked = ucv2KeepRemovedModIds.has(cb.dataset.ucv2RemkeepModid);
  });
  ucv2UpdateRemKeepCount();
}

// reseed=true (the default, real first entry via ucv2StartReview) seeds fresh keep/remove defaults.
// reseed=false (Review screen's own Back button, re-entering an already-in-progress review) leaves
// ucv2KeepRemovedModIds exactly as the director already set it -- confirmed real, 2026-08-26: without
// this, going Back from Review to re-check the Remove list silently discarded every choice already
// made, reseeding back to "only shared mods kept" every time.
function ucv2RenderRemovedScreen(reseed = true) {
  const r = ucv2CurrentReview;
  $ucv2('ucv2RemovedTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  ucv2SetScreenHeadThumb('ucv2RemovedThumb', r.pictureUrl);
  ucv2RenderRevisionPicker('ucv2RemovedRevisionPicker', 'ucv2ScreenRemoved');
  ucv2RenderInstructions('ucv2RemovedInstructions', 'ucv2RemovedInstructionsBody');
  const n = r.removed.length;
  // The same one quiet line as the Review step (the name is Vortex's until the update writes the new one).
  const removedRenameNote = $ucv2('ucv2RemovedRenameNote');
  if (removedRenameNote) { removedRenameNote.textContent = r.renameNote || ''; removedRenameNote.classList.toggle('hidden', !r.renameNote); }
  $ucv2('ucv2RemovedLead').textContent = `The collection's author dropped ${n} mod${n === 1 ? '' : 's'} from this revision. Check any you'd like to keep installed before continuing.`;

  // Default is UNCHECKED (removed) -- matches the collection author's own intent for an ordinary
  // dropped mod. The one exception: a mod flagged "shared" (required by another installed
  // collection too) defaults CHECKED (kept) -- removing it would break that other collection, so
  // that's the one case where the safer default is protecting it instead (director's own call,
  // 2026-08-26, refined from the initial "everything checked" pass once live-tested).
  if (reseed) {
    ucv2KeepRemovedModIds = new Set(r.removed.filter((m) => m.shared).map(ucv2RemovedModId));
  }

  // "Shared with another collection" (2026-08-21) -- same real detection Safe Collection Removal's
  // own Screen 2 uses (review.removed[].shared/usedBy, backend: reviewUpdate in
  // update-collection-v2-runner.js).
  const sharedCount = r.removed.filter((m) => m.shared).length;
  $ucv2('ucv2RemovedSharedWarning').classList.toggle('hidden', sharedCount === 0);
  if (sharedCount > 0) {
    $ucv2('ucv2RemovedSharedWarningTitle').textContent = `⚠️ Shared Dependencies: ${sharedCount} of these mods ${sharedCount === 1 ? 'is' : 'are'} also required by another installed collection.`;
  }

  // Shared mods sorted to the top (2026-08-26) -- they're the ones defaulting to checked/kept and
  // needing a real look, so they shouldn't be buried in an alphabetical/arbitrary middle of a long
  // list. Stable sort (shared first, original relative order preserved within each group).
  const sortedRemoved = [...r.removed].sort((a, b) => (b.shared ? 1 : 0) - (a.shared ? 1 : 0));

  $ucv2('ucv2RemovedList').innerHTML = sortedRemoved.map((m) => {
    const modId = ucv2RemovedModId(m);
    return `
    <div class="ucv2-op-row ucv2-op-row--remove${m.shared ? ' ucv2-op-row--shared' : ''}">
      <label class="ucv2-op-row__main" style="cursor:pointer">
        <input type="checkbox" data-ucv2-remkeep-modid="${escHtmlUcv2(modId)}" ${ucv2KeepRemovedModIds.has(modId) ? 'checked' : ''}>
        <div class="ucv2-op-row__name">${escHtmlUcv2(m.name)}</div>
        <div class="ucv2-op-row__detail">${m.shared ? `Required by: ${escHtmlUcv2(m.usedBy.join(', '))}${m.version || m.author ? ' &middot; ' : ''}` : ''}${m.version ? escHtmlUcv2(m.version) : ''}${m.version && m.author ? ' · ' : ''}${m.author ? `by ${escHtmlUcv2(m.author)}` : ''}</div>
      </label>
    </div>`;
  }).join('');

  document.querySelectorAll('#ucv2RemovedList input[data-ucv2-remkeep-modid]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.ucv2RemkeepModid;
      if (cb.checked) ucv2KeepRemovedModIds.add(id); else ucv2KeepRemovedModIds.delete(id);
      ucv2UpdateRemKeepCount();
    });
  });
  ucv2UpdateRemKeepCount();
}

$ucv2('ucv2RemKeepSelectAllBtn').addEventListener('click', () => {
  (ucv2CurrentReview?.removed || []).forEach((m) => ucv2KeepRemovedModIds.add(ucv2RemovedModId(m)));
  ucv2SyncRemKeepCheckboxes();
});
$ucv2('ucv2RemKeepInvertBtn').addEventListener('click', () => {
  (ucv2CurrentReview?.removed || []).forEach((m) => {
    const id = ucv2RemovedModId(m);
    if (ucv2KeepRemovedModIds.has(id)) ucv2KeepRemovedModIds.delete(id); else ucv2KeepRemovedModIds.add(id);
  });
  ucv2SyncRemKeepCheckboxes();
});
$ucv2('ucv2RemKeepClearBtn').addEventListener('click', () => {
  ucv2KeepRemovedModIds.clear();
  ucv2SyncRemKeepCheckboxes();
});
$ucv2('ucv2RemovedContinueBtn').addEventListener('click', () => {
  ucv2DeleteArchives = $ucv2('ucv2DeleteArchivesCheckbox').checked;
  ucv2RenderReviewScreen();
  ucv2GoScreen('ucv2Screen2');
});

// Merged-plugin flag (2026-08-25, popover added 2026-08-27) -- {filenames, mergeNames, mergeIds,
// files}, set by the backend (lib/update-collection-v2-runner.js's reviewUpdate, via
// lib/merged-plugin-lookup.js) whenever an Updated/Added mod's plugin is on record as merged away by
// Merge Plugins. Informational only, same "flag it, never block it" convention Review already follows
// everywhere else (the version arrow, the FOMOD-choices label, the shared-with-another-collection
// warning on Removed) -- the director decides what to do; this never disables the row or the Apply
// button.
//
// The always-visible label used to read "Already merged into <every merge name>, ... -- bringing this
// back may conflict with your merged plugin" off a native title="" tooltip listing the raw filenames.
// Real bug, confirmed live: filenames/mergeNames are built from one entry per merge RECORD, so a
// single plugin file on record in 5 different merges repeated the identical tooltip text 5 times. Now
// the label is a short singular/plural summary (off the DISTINCT merge-name count, not raw record
// count) and the detail moves into a real popover, grouped by distinct file -- see
// ucv2MergedFlagPopoverHtml below, and computeMergedPluginFlag's own `files` field for why that grouping
// can't be derived from the flatter filenames/mergeNames arrays.
function ucv2MergedFlagPopoverHtml(flag) {
  const fileBlocks = flag.files.map((f) => {
    const items = f.mergeNames.map((n) => `<li>${escHtmlUcv2(n)}</li>`).join('');
    return `<div class="ucv2-merged-flag-popover__file">${escHtmlUcv2(f.filename)} — found in:</div><ul>${items}</ul>`;
  }).join('');
  return `${fileBlocks}<div class="ucv2-merged-flag-popover__note">Bringing this mod back may conflict with what's currently in the merged plugin(s) named above.</div>`;
}

// Inline, muted "(bundled)" tag next to a mod's own name in the Review table (2026-08-29,
// director's own ask) -- flags a source.type === 'bundle' mod (content packaged inside the
// collection's own downloaded archive under bundled/<fileExpression>/, not a separate Nexus
// download -- see lib/bundle-resolver.js) so it's visually obvious before Apply, not just
// discoverable after the fact from its own Vortex attributes.
function ucv2BundledFlagHtml(isBundled) {
  return isBundled ? ' <span style="color:var(--text-muted);font-weight:400">(bundled)</span>' : '';
}

function ucv2MergedPluginFlagHtml(flag) {
  if (!flag) return '';
  const label = flag.mergeNames.length === 1 ? 'Contained in a merged patch' : 'Contained in merged patches';
  const popoverHtml = ucv2MergedFlagPopoverHtml(flag);
  // data-* attribute, HTML-escaped -- same convention as instrBtn's data-ucv2-instr-body below.
  // .dataset reads it back HTML-decoded, so the delegated hover/focus handler gets the real markup
  // (bullets included) ready to drop straight into the popover's innerHTML.
  return `<br><span class="ucv2-merged-flag" tabindex="0" data-ucv2-merge-popover="${escHtmlUcv2(popoverHtml)}">⚠️ ${label}</span>`;
}

// One shared fixed-position popover element (created lazily, reused) -- same getBoundingClientRect-
// driven positioning theme.js's wireHomeCardTooltip already established for the home-card name
// tooltip, needed here too since the Review table's own scrollable wrapper
// (.plan-table-wrap--scrollable, overflow-y: auto) would otherwise clip an absolutely-positioned
// popover nested inside it.
let ucv2MergedFlagPopoverEl = null;
function ucv2ShowMergedFlagPopover(anchorEl) {
  if (!ucv2MergedFlagPopoverEl) {
    ucv2MergedFlagPopoverEl = document.createElement('div');
    ucv2MergedFlagPopoverEl.className = 'ucv2-merged-flag-popover';
    document.body.appendChild(ucv2MergedFlagPopoverEl);
  }
  ucv2MergedFlagPopoverEl.innerHTML = anchorEl.dataset.ucv2MergePopover || '';
  ucv2MergedFlagPopoverEl.classList.add('visible');
  const rect = anchorEl.getBoundingClientRect();
  const popRect = ucv2MergedFlagPopoverEl.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - popRect.height - 8));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popRect.width - 8));
  ucv2MergedFlagPopoverEl.style.top = `${top}px`;
  ucv2MergedFlagPopoverEl.style.left = `${left}px`;
}
function ucv2HideMergedFlagPopover() {
  if (ucv2MergedFlagPopoverEl) ucv2MergedFlagPopoverEl.classList.remove('visible');
}
// mouseover/mouseout (not mouseenter/mouseleave, which don't bubble) + focusin/focusout so this
// works as one delegated listener pair on the table body, same pattern the rest of this file's own
// dynamically-rendered rows already use for click (e.g. the Instructions button below) rather than
// re-wiring listeners on every re-render.
$ucv2('ucv2ReviewTableBody').addEventListener('mouseover', (e) => {
  const flagEl = e.target.closest('.ucv2-merged-flag');
  if (flagEl) ucv2ShowMergedFlagPopover(flagEl);
});
$ucv2('ucv2ReviewTableBody').addEventListener('mouseout', (e) => {
  if (e.target.closest('.ucv2-merged-flag')) ucv2HideMergedFlagPopover();
});
$ucv2('ucv2ReviewTableBody').addEventListener('focusin', (e) => {
  const flagEl = e.target.closest('.ucv2-merged-flag');
  if (flagEl) ucv2ShowMergedFlagPopover(flagEl);
});
$ucv2('ucv2ReviewTableBody').addEventListener('focusout', (e) => {
  if (e.target.closest('.ucv2-merged-flag')) ucv2HideMergedFlagPopover();
});

function ucv2RowHtml(status, pillClass, name, versionText, keepCellHtml, author, instructions, rowClass, modKey, mergedPluginFlag, versionTooltip, isBundled, versionNote, statusTooltip) {
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
  // modKey (2026-08-22) -- Updated/Added rows only, the same Nexus modId Apply's own live
  // mod-start/mod-complete SSE frames carry (runner.runApply). Originally read by this table's own
  // live-progress mechanism; that moved to the dedicated Apply Progress screen's own table
  // (ucv2SyncApplyProgressRows, data-ucv2-apply-mod-key -- a deliberately different attribute name)
  // once Apply stopped mutating THIS table in place (2026-08-28). Left in place as harmless,
  // currently-unread bookkeeping rather than touching every one of this function's call sites to
  // remove it for zero behavior change.
  const keyAttr = modKey ? ` data-ucv2-mod-key="${escHtmlUcv2(modKey)}"` : '';
  // versionTooltip (2026-08-26) -- optional hover explanation for the two special-case version
  // labels ("FOMOD", a same-version-label re-upload) that read as confusing/no-op-looking without
  // one. A plain <span title> wrapper, same lightweight approach the rest of this table's own
  // tooltips use (e.g. the Keep-installed checkbox's own title attribute) rather than a heavier
  // tooltip component.
  const versionCell = (versionTooltip
    ? `<span title="${escHtmlUcv2(versionTooltip)}" style="cursor:help">${escHtmlUcv2(versionText)}</span>`
    : escHtmlUcv2(versionText))
    + (versionNote ? `<br><span class="muted" style="font-size:12px">${escHtmlUcv2(versionNote)}</span>` : '');
  // The status chip's tooltip (hover, and keyboard focus through tabindex + aria-label).
  const statusPill = statusTooltip
    ? `<span class="status-pill ${pillClass}" tabindex="0" title="${escHtmlUcv2(statusTooltip)}" aria-label="${escHtmlUcv2(status + '. ' + statusTooltip)}" style="cursor:help">${status}</span>`
    : `<span class="status-pill ${pillClass}">${status}</span>`;
  // data-status (2026-08-28, status filter pills) -- derived from the same `status` label every row
  // already carries (Update/New/Remove/Keep/Installed), lowercased to match the filter badges' own
  // data-status values. Every row gets one, including Keep/Installed (no pill selects those, but the
  // filter still needs to know what to hide when a different pill IS active).
  const statusAttr = ` data-status="${escHtmlUcv2(status.toLowerCase())}"`;
  return `<tr${cls}${keyAttr}${statusAttr}><td>${statusPill}</td><td>${escHtmlUcv2(name)}${ucv2BundledFlagHtml(isBundled)}${ucv2MergedPluginFlagHtml(mergedPluginFlag)}</td><td>${versionCell}</td><td class="ucv2-keep-col">${keepCellHtml}</td><td>${escHtmlUcv2(author || '')}</td><td>${instrBtn}</td></tr>`;
}

// ---- Keep-installed-version choice (2026-08-18) -- "I already have Mod version 2.3.0 installed,
// and the collection replaced it 2.2.5 -- I want to keep the newer mod" (the director's own real
// case). Updated bucket only. Keyed by Nexus modId (u.old.source.modId), stable across the diff,
// same "hold a stable identity, not an array index, in client state" reasoning already used
// elsewhere in this app. Same Select All/Invert Selection/Clear Selection convention Archive
// Finder's own real selection bar already established (afSelectAllBtn etc., afState.selected). ----
let ucv2KeepInstalledModIds = new Set();

// modId:fileId, NOT just u.old.source.modId (2026-08-28, same real collision ucv2RemovedModId was
// already fixed for on 2026-08-26, confirmed hitting the Updated bucket too on a real live
// collection: multiple HIMBO/CBBE 3BA file-variant pairs, e.g. "CuBoCorrx Repository - Bsu
// Settings"/"- BSU BS Output", share a modId with a different fileId each). See ucv2AddedModId's own
// header comment below for the full real symptom this caused. Matches
// lib/update-collection-v2-runner.js's own Updated-mod loop modId construction (sourceModFileKey)
// exactly -- keep both in sync if this key ever changes again.
function ucv2UpdatedModId(u) {
  const modId = u.old.source && u.old.source.modId;
  const fileId = u.old.source && u.old.source.fileId;
  return modId != null && fileId != null ? `${modId}:${fileId}` : String(modId ?? u.new.name);
}

// Added-bucket key -- modId:fileId, NOT just m.source.modId (2026-08-28, same real collision
// ucv2RemovedModId was already fixed for on 2026-08-26, confirmed hitting the Added bucket too on a
// real live collection: "HDT-SMP Distinct Falmer Hardened Armor - HIMBO" and "- CBBE 3BA" are two
// separate fileIds under the same Nexus modId. Keying on modId alone collapsed their Apply Progress
// rows onto the SAME map entry (ucv2ApplyProgressRows.set overwrites on the second row's own
// key) -- the second row's SSE updates silently updated the WRONG row, leaving its own row frozen on
// "Download pending" forever even though the mod itself finished processing. Matches
// lib/update-collection-v2-runner.js's own Added-mod loop modId construction exactly -- keep both in
// sync if this key ever changes again.
function ucv2AddedModId(m) {
  const modId = m.source && m.source.modId;
  const fileId = m.source && m.source.fileId;
  return modId != null && fileId != null ? `${modId}:${fileId}` : String(modId ?? m.name);
}

// Removed-bucket key -- NOT just m.source.modId (unlike Updated/Added above): confirmed real,
// 2026-08-26, a single Nexus mod PAGE can ship several separate optional files that all end up in
// review.removed independently (e.g. "Somewhere in Between - Helmets"/"- Guards"/"- 3BA Armor
// ReplacerPM", three different fileIds under the SAME modId 98945). Keying on modId alone silently
// merged their checkbox state -- checking one appeared to check all three. modId:fileId is unique per
// real file; falls back to modId alone (then name) only if fileId is somehow missing. Matches
// runner.runApply's own keepRemovedModIdSet lookup (lib/update-collection-v2-runner.js) exactly --
// keep both in sync if this key ever changes again.
function ucv2RemovedModId(m) {
  const modId = m.source && m.source.modId;
  const fileId = m.source && m.source.fileId;
  if (modId != null && fileId != null) return `${modId}:${fileId}`;
  return String(modId ?? m.name);
}

// Whether an Updated-bucket entry actually gets a "Keep installed" checkbox at all -- shared by the
// row renderer, the count, and the Select-all/Invert/Clear handlers so all four stay in sync (2026-08-26).
// Two real cases have no real choice to offer: a FOMOD-choices-only change (u.fileChanged === false,
// nothing to "keep" at a different version -- there's no version difference at all), and a
// same-version-LABEL-but-different-file re-upload (see ucv2RenderReviewScreen's own row-building
// comment for why "Keep installed" doesn't make sense there either -- just update automatically).
// Narrowed to ONLY the real downgrade-protection case (2026-08-26, director's own call): "the only
// time Keep installed should come up is if the mod in the updated collection is going to downgrade
// the mod installed -- there is no other use case to keep installed except for that. Everything else
// gets updated." u.installedIsNewer (server-resolved, isInstalledVersionNewer) is exactly that check
// -- this single condition also naturally covers the FOMOD-only case (u.fileChanged === false can
// never be installedIsNewer, there's no version difference at all) and the same-version-label
// re-upload case (identical version can't be "newer" either), so neither needs its own separate check
// anymore.
function ucv2HasKeepChoice(u) {
  return !!u.installedIsNewer;
}

function ucv2UpdateKeepCount() {
  // Only counts mods that actually HAVE a "keep installed" checkbox -- a FOMOD-choices-only update
  // or a same-version-label re-upload has no checkbox at all, so this used to pad the denominator
  // with mods nobody could ever check ("0 of 2 kept" when 0 of those 2 even offered the choice).
  const total = (ucv2CurrentReview?.updated || []).filter(ucv2HasKeepChoice).length;
  const n = ucv2KeepInstalledModIds.size;
  $ucv2('ucv2KeepCount').textContent = total ? `${n} of ${total} kept at installed version` : '';
}

function ucv2SyncKeepCheckboxes() {
  document.querySelectorAll('#ucv2ReviewTableBody input[data-ucv2-keep-modid]').forEach((cb) => {
    cb.checked = ucv2KeepInstalledModIds.has(cb.dataset.ucv2KeepModid);
  });
  ucv2UpdateKeepCount();
}

// ---- Apply Progress screen (2026-08-28, director's own build-out, matching the finalized mockup's
// own #screen3 -- design/vortex-update-collection-v2-mockup.html is the word-of-truth spec for the
// real Vortex status vocabulary/colors this whole section renders). A genuinely NEW dedicated screen
// -- live per-mod status used to mutate the Review table's own Status column in place (Update/Added
// rows only; Remove rows had ZERO live progress at all, a real gap this build-out also fixes). Every
// pill renders through the ONE shared ucv2ApplyPillHtml lookup (update-collection-v2-apply-pills.js)
// -- never a second, separately-maintained styling path for the main-apply vs. optional-apply case,
// the exact divergence the mockup's own two-demo-entry-point history already warned against. ----

// Mirrors app.js's own state.progressRows/updateProgressRow mechanism (a Map from a stable id to its
// <tr>, refreshed via querySelectorAll right after the table's own innerHTML render) -- same
// convention this table's own predecessor (the old in-place Review-table version) already used,
// just re-targeted at this screen's own table and its own data-ucv2-apply-mod-key attribute
// (deliberately a DIFFERENT attribute name from ucv2RowHtml's own data-ucv2-mod-key, which is now
// otherwise-unused Review-table bookkeeping -- keeping the two attributes distinct avoids any chance
// of this table's own lookup accidentally matching a stale Review-table row).
// Rows are addressed by POSITION now (2026-09-28, see update-collection-v2-apply-rows.js's own header for the
// real run this fixes): a Map<key, row> let two rows that share a key overwrite each other, and a row whose
// key the server never sent could never change. ucv2ApplyTracker (pure, testable) decides what happens to which
// row; the functions below only carry those decisions out on the DOM.
let ucv2ApplyProgressRowEls = [];
let ucv2ApplyProgressRowData = [];
let ucv2ApplyTracker = null;
let ucv2ApplyProgressTotal = 0;
let ucv2ApplyProgressDone = 0;

function ucv2SyncApplyProgressRows() {
  ucv2ApplyProgressRowEls = [];
  document.querySelectorAll('#ucv2ApplyProgressTableBody tr[data-ucv2-apply-row-index]').forEach((row) => {
    ucv2ApplyProgressRowEls[Number(row.dataset.ucv2ApplyRowIndex)] = row;
  });
}

function ucv2BumpApplyProgressBar() {
  ucv2ApplyProgressDone += 1;
  const pct = ucv2ApplyProgressTotal > 0 ? Math.round((ucv2ApplyProgressDone / ucv2ApplyProgressTotal) * 100) : 0;
  $ucv2('ucv2ApplyProgressFill').style.width = `${pct}%`;
}

// key/title: key is one of update-collection-v2-apply-pills.js's own UCV2_APPLY_PILL_STYLES keys
// ('removing'/'downloading'/'installing'/'enabled'/'failed'/'skipped'); title is an optional real
// failure message shown as a hover tooltip (same "no dedicated Detail column" reasoning the old
// in-place mechanism already used -- most rows never show one at all).
function ucv2UpdateApplyProgressRow(index, key, label, title) {
  const row = ucv2ApplyProgressRowEls[index];
  if (!row || !row.isConnected) return;
  const cell = row.children[0];
  const pillHtml = ucv2ApplyPillHtml(key, escHtmlUcv2(label));
  cell.innerHTML = title ? pillHtml.replace('<span class="status-pill', `<span title="${escHtmlUcv2(title)}" class="status-pill`) : pillHtml;
  // Same bounded-wrap scroll math as app.js's own updateProgressRow -- row.scrollIntoView() walks
  // every scrollable ancestor including the window itself, which is what caused the whole page to
  // bounce there; this only ever scrolls this screen's own table wrap's inner scroll position.
  const wrap = $ucv2('ucv2ApplyProgressTableWrap');
  if (wrap) {
    const rowRect = row.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const offsetWithinWrap = (rowRect.top - wrapRect.top) + wrap.scrollTop;
    const target = offsetWithinWrap - (wrap.clientHeight / 2) + (row.clientHeight / 2);
    wrap.scrollTo({ top: target, behavior: 'smooth' });
  }
}

// A Remove row fades and vanishes once its removal genuinely completes (see .apply-row--leaving in
// styles.css) rather than lingering with an "Enabled" pill that doesn't really apply to a removal --
// matches the mockup's own real behavior exactly. A FAILED remove stays visible with a real pill
// instead (never called for ok:false), so a real problem is never silently hidden.
function ucv2RemoveApplyProgressRow(index) {
  const row = ucv2ApplyProgressRowEls[index];
  if (!row || !row.isConnected) return;
  row.classList.add('apply-row--leaving');
  setTimeout(() => row.remove(), 500);
}

// Actively-worked-on rows float to the top of the table (2026-08-30, director's own real catch: on a
// collection with hundreds of rows, whatever's currently happening is easy to lose track of buried
// wherever it happened to sort). Real Vortex's own Downloads/Mods lists do the same thing -- an
// in-progress item sorts to where you're actually looking, not wherever it started. A no-op if the
// row is already first (the common case once a handful of rows have already cycled through).
function ucv2MoveApplyProgressRowToTop(index) {
  const row = ucv2ApplyProgressRowEls[index];
  const body = $ucv2('ucv2ApplyProgressTableBody');
  if (!row || !row.isConnected || !body || body.firstElementChild === row) return;
  body.insertBefore(row, body.firstElementChild);
}

// Every kind of row got the SAME "Download pending" label -- read as "this is about to be
// downloaded" even for a mod that's actually about to be UNINSTALLED or just re-extracted from an
// archive already on disk, confirmed confusing live (2026-09-01, director caught it mid-apply on a
// real "Community Shaders - Cloud Shadows" removal row). Split per kind instead; nothing else about
// the pill changes (same grey 'pending' visual state) -- only the text.
const UCV2_PENDING_LABEL_BY_KIND = { remove: 'Removal pending', update: 'Update pending' };
function ucv2ApplyProgressRowHtml(modKey, name, versionText, kind, index) {
  const label = UCV2_PENDING_LABEL_BY_KIND[kind] || 'Download pending';
  return `<tr data-ucv2-apply-row-index="${index}" data-ucv2-apply-mod-key="${escHtmlUcv2(modKey)}"><td class="ucv2-apply-status-col">${ucv2ApplyPillHtml('pending', label)}</td><td>${escHtmlUcv2(name)}</td><td>${escHtmlUcv2(versionText)}</td></tr>`;
}

// The main apply's own row set: every Updated/Added mod (all of them -- Apply never skips these
// buckets), plus every Removed mod EXCEPT the ones the director explicitly chose to keep (kept mods
// are never touched by Apply at all, so they'd never receive a real mod-complete event -- showing
// them here would leave a permanent "Download pending" row nothing ever resolves).
function ucv2BuildMainApplyRows() {
  const r = ucv2CurrentReview;
  const rows = [];
  // The version text is the INSTALLED version -> the new one, never the old collection record's version; a row
  // whose only change is the install options shows the version once, with the same note the review uses.
  r.updated.forEach((u) => rows.push({
    modKey: ucv2UpdatedModId(u), name: u.new.name, kind: 'update',
    versionText: u.fileChanged === false
      ? `${ucv2VersionLabel(u.new.version)} · install options changed`
      : `${ucv2VersionLabel(u.liveInstalledVersion ?? u.old.version)} → ${ucv2VersionLabel(u.new.version)}`,
  }));
  r.added.forEach((m) => rows.push({ modKey: ucv2AddedModId(m), name: m.name, versionText: ucv2VersionLabel(m.version), kind: 'add' }));
  r.removed.filter((m) => !ucv2KeepRemovedModIds.has(ucv2RemovedModId(m)))
    .forEach((m) => rows.push({ modKey: ucv2RemovedModId(m), name: m.name, versionText: m.version ? ucv2VersionLabel(m.version) : '', kind: 'remove' }));
  return rows;
}

// The optional-mods apply pass's own row set -- the director-picked optional mods, real data from
// THIS run (never reused from whatever the main update's own table last showed -- confirmed real bug
// the mockup itself hit and got caught on; see prepareApplyOptional's own header comment for why the
// backend re-derives review.optionalMods fresh every time rather than trusting a client-held list).
// Uses the SAME modId keying ucv2AddedModId already establishes -- prepareApplyOptional's own
// `added` entries retain their real source.modId, and runApply's Added-mod loop keys its SSE frames
// by that same value regardless of which apply pass is running.
function ucv2BuildOptionalApplyRows(mods) {
  return mods.map((m) => ({ modKey: ucv2AddedModId(m), name: m.name, versionText: ucv2VersionLabel(m.version) }));
}

function ucv2RenderApplyProgressScreen(rows, title, thumbUrl) {
  $ucv2('ucv2ApplyProgressTitle').textContent = title;
  ucv2SetScreenHeadThumb('ucv2ApplyProgressThumb', thumbUrl);
  $ucv2('ucv2ApplyProgressPhaseText').textContent = 'Starting…';
  $ucv2('ucv2ApplyProgressFill').style.width = '0%';
  $ucv2('ucv2ApplyProgressTableBody').innerHTML = rows.map((r, i) => ucv2ApplyProgressRowHtml(r.modKey, r.name, r.versionText, r.kind, i)).join('');
  ucv2ApplyProgressRowData = rows;
  ucv2ApplyTracker = ucv2CreateApplyRowTracker(rows);
  ucv2ApplyProgressTotal = rows.length;
  ucv2ApplyProgressDone = 0;
  ucv2SyncApplyProgressRows();
  ucv2GoScreen('ucv2ScreenApplyProgress');
}

$ucv2('ucv2ReviewTableBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-ucv2-keep-modid]');
  if (!cb) return;
  if (cb.checked) ucv2KeepInstalledModIds.add(cb.dataset.ucv2KeepModid);
  else ucv2KeepInstalledModIds.delete(cb.dataset.ucv2KeepModid);
  ucv2UpdateKeepCount();
});
$ucv2('ucv2KeepSelectAllBtn').addEventListener('click', () => {
  // Only mods that actually HAVE a checkbox (ucv2HasKeepChoice) -- otherwise Select all would
  // silently opt a same-version-label re-upload out of updating, even though its own row never
  // showed a checkbox offering that choice at all.
  (ucv2CurrentReview?.updated || []).filter(ucv2HasKeepChoice).forEach((u) => ucv2KeepInstalledModIds.add(ucv2UpdatedModId(u)));
  ucv2SyncKeepCheckboxes();
});
$ucv2('ucv2KeepInvertBtn').addEventListener('click', () => {
  (ucv2CurrentReview?.updated || []).filter(ucv2HasKeepChoice).forEach((u) => {
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
  if (r.continueOnly) { ucv2RenderContinueOnly(r); return; }
  // A normal review: bring back whatever the Continue screen hid.
  for (const id of ['ucv2ReviewTableWrap', 'ucv2ApplyUpdateBtn']) { const el = $ucv2(id); if (el) el.classList.remove('hidden'); }
  $ucv2('ucv2ReviewTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  ucv2SetScreenHeadThumb('ucv2ReviewThumb', r.pictureUrl);
  // Said once, quietly, when Nexus has renamed the collection (the update writes the new name into Vortex).
  const renameNoteEl = $ucv2('ucv2ReviewRenameNote');
  renameNoteEl.textContent = r.renameNote || '';
  renameNoteEl.classList.toggle('hidden', !r.renameNote);
  // Revision picker only shows here when the Remove screen was skipped this run (zero mods to
  // remove) -- when there WAS a Remove screen, the pick already happened there; showing a second,
  // independent picker here would let the two screens' own selected revision drift out of sync
  // (director's own live catch, 2026-08-28: "should be hidden on this page -- it only shows on this
  // page if there are no mods to remove").
  const reviewHasRemoved = (r.removed?.length || 0) > 0;
  if (reviewHasRemoved) {
    $ucv2('ucv2ReviewRevisionPicker').classList.add('hidden');
    $ucv2('ucv2ReviewRevisionPicker').innerHTML = '';
  } else {
    ucv2RenderRevisionPicker('ucv2ReviewRevisionPicker', 'ucv2Screen2');
  }
  ucv2RenderInstructions('ucv2ReviewInstructions', 'ucv2ReviewInstructionsBody');
  // Same real nexusCollectionUrl(slug, revisionNumber) app.js's own collection picker and Workshop
  // Report's "View on Nexus" button already use -- only shown when a slug is actually on record
  // (same conditional-disable convention as Workshop Report's own row.slug check).
  const viewOnNexusBtn = $ucv2('ucv2ReviewViewOnNexusBtn');
  viewOnNexusBtn.classList.toggle('hidden', !r.collectionSlug);
  viewOnNexusBtn.onclick = () => window.open(nexusCollectionUrl(r.collectionSlug, r.newRevisionNumber || undefined), '_blank');
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
  const addedNote = r.added.length === 0 ? '' : `, and ${r.added.length} new mod${r.added.length === 1 ? '' : 's'} ${r.added.length === 1 ? 'is' : 'are'} being added`;
  // Real breakdown, not a generic "changing" bucket (2026-08-28, director's own catch, live: a
  // remove-only revision read "19 of your 19 installed mods are changing" -- true in the sense that
  // their installed state is about to change, but "changing" implies an in-place update, and these 19
  // are being REMOVED, not updated. Only Update/Remove ever populate installedChanged (Added was
  // never part of it, see installedTotal's own comment above) -- when just ONE of the two is actually
  // present this revision (by far the common case), keeps the director's own preferred "N of your Y
  // installed mods are being {verb}" sentence shape, confirmed live, with the real verb instead of one
  // generic word. A genuine MIX of both in the same revision needs its own two-clause sentence instead
  // -- "N of your Y installed mods X are being updated and Z are being removed" would repeat the total
  // twice with no clear referent for the first number. "—the rest remain untouched" only when there
  // genuinely IS a rest (unchanged > 0) -- a revision with nothing left unchanged has no "rest" to
  // claim untouched.
  const updatedVerb = r.updated.length === 1 ? 'is' : 'are';
  const removedVerb = r.removed.length === 1 ? 'is' : 'are';
  const restNote = r.unchanged.length > 0 ? '—the rest remain untouched' : '';
  let changeSummary;
  if (r.updated.length > 0 && r.removed.length > 0) {
    changeSummary = `Of your ${installedTotal} installed mods, ${r.updated.length} ${updatedVerb} being updated and ${r.removed.length} ${removedVerb} being removed`;
  } else if (r.updated.length > 0) {
    changeSummary = `${r.updated.length} of your ${installedTotal} installed mods ${updatedVerb} being updated`;
  } else {
    changeSummary = `${r.removed.length} of your ${installedTotal} installed mods ${removedVerb} being removed`;
  }
  // Bolded to match its real button label exactly (plain-language-writer skill's "bold exact UI
  // labels" rule) -- innerHTML, not textContent, since that's the only way <strong> actually renders
  // rather than showing up as literal angle brackets; every value interpolated here is a plain number
  // (.length), never raw/unescaped text, so this is safe without an HTML-escaping pass.
  // No-mod-changes case (2026-08-28, director's own catch) -- moved out of the plain .lead paragraph
  // into its own Info/💡 tip callout (DESIGN.md's severity table: blue/💡 for a tip/suggestion, same
  // treatment as the "💡 Instructions" callout above), since this is telling the director something
  // worth noticing (an update exists with nothing in the mod list to show for it), not just narrating
  // the diff like every other case here still does in the plain lead line.
  const noChanges = totalChanged === 0;
  $ucv2('ucv2ReviewNoChangesTip').classList.toggle('hidden', !noChanges);
  $ucv2('ucv2ReviewLead').classList.toggle('hidden', noChanges);
  if (noChanges) {
    $ucv2('ucv2ReviewNoChangesTipBody').innerHTML = "This revision contains no mod changes, but rules or metadata may have been updated. Click <strong>Apply update</strong> to apply these changes.";
    $ucv2('ucv2ReviewLead').innerHTML = '';
  } else {
    $ucv2('ucv2ReviewLead').innerHTML = installedTotal === 0
      ? `This revision adds ${r.added.length} new mod${r.added.length === 1 ? '' : 's'} to this collection. Review the changes below and click <strong>Apply update</strong> when you're ready. No files are modified until you confirm.`
      : installedChanged === 0
        ? `None of your ${installedTotal} installed mods change in this update${addedNote}—they'll remain untouched. Review the changes below and click <strong>Apply update</strong> when you're ready. No files are modified until you confirm.`
        : `${changeSummary} in this update${addedNote}${restNote}. Review the changes below and click <strong>Apply update</strong> when you're ready. No files are modified until you confirm.`;
  }

  ucv2RenderContinueGroups(r);

  // Pre-check "keep installed version" for a mod whose live install is genuinely newer than this
  // revision's own pin -- a real, deliberate default the director asked for; see
  // isInstalledVersionNewer's own header comment (server-side) for why it's conservative.
  ucv2KeepInstalledModIds = new Set(r.updated.filter((u) => u.installedIsNewer).map(ucv2UpdatedModId));

  const rows = [
    // Removed/Kept listed FIRST (2026-08-30, director's own catch: these are the first thing Apply
    // actually acts on -- see runApply's own phase order -- so on a long list they shouldn't be
    // buried at the bottom where they're easy to miss before confirming.
    ...r.removed.map((m) => (ucv2KeepRemovedModIds.has(ucv2RemovedModId(m))
      ? ucv2RowHtml('Keep', 'status-pill--neutral', m.name, m.version ? ucv2VersionLabel(m.version) : '', '', m.author, undefined)
      : ucv2RowHtml('Remove', 'status-pill--critical', m.name, m.version ? ucv2VersionLabel(m.version) : '', '', m.author, undefined, undefined, undefined, undefined,
        m.notInstalled ? UCV2_NOT_INSTALLED_REMOVE_TIP : undefined))),
    ...r.updated.map((u) => {
      // A choices-only change (u.fileChanged === false) is the exact same file, just different FOMOD
      // picks -- showing "v1.1 -> v1.1" reads as a bug, not a real update, so label it by what
      // actually changed instead. Reverted to bare "FOMOD" (2026-08-26) -- "Install choices changed"
      // wrapped in the narrow Version column; a real tooltip is the fix for the "what does FOMOD
      // mean" confusion instead of a longer label (see design/gemini-ucv2-review-tooltips-prompt.md).
      // "Keep installed version" doesn't apply either: that choice is about which FILE stays
      // installed, and there's only one file here.
      if (u.fileChanged === false) {
        // Gemini pass (queue item ucv2-review-tooltips-copy, landed 2026-08-26) -- see
        // design/gemini-ucv2-review-tooltips-prompt.md for the prompt this came from.
        // Disabled (2026-08-30) -- a real live-Disabled mod still gets its file/choices updated
        // exactly like any other Updated row (runApply's own Phase 2b restores the Disabled state
        // afterward); this only overrides the status label/pill so the row doesn't read as a plain
        // Update, matching real Vortex's own status for it.
        const parts = ucv2UpdateRowParts(u, '', ucv2VersionLabel(u.new.version));
        return ucv2RowHtml(u.disabled ? 'Disabled' : 'Update', u.disabled ? 'status-pill--disabled' : 'status-pill--info', u.new.name, parts.versionText, '', u.new.author, u.new.instructions, undefined, ucv2UpdatedModId(u), u.mergedPluginFlag,
          undefined, u.new.source?.type === 'bundle', parts.versionNote, parts.statusTooltip);
      }
      const modId = ucv2UpdatedModId(u);
      const note = u.installedIsNewer ? '<br><span class="muted" style="font-size:12px">Your installed version is newer</span>' : '';
      // Real live version (server-resolved via the Vortex Bridge, cross-referenced against Vortex's actual
      // current mod state) wins over the collection's own stale old-revision recording whenever it
      // differs -- so a mod updated outside this collection's tracking shows what's really about to
      // happen (your real version -> the new revision's version), not a backwards-reading arrow built
      // from a pin that's no longer true. Falls back to the collection's own recording when the Vortex Bridge
      // couldn't resolve this mod live (unreachable, or a genuinely new/ambiguous case).
      const fromVersion = u.liveInstalledVersion ?? u.old.version;
      // Only ever shown for the real downgrade-protection case now (ucv2HasKeepChoice narrowed to
      // installedIsNewer, 2026-08-26) -- one single tooltip, no longer conditional. Every other
      // version-changing row (a plain upgrade, a same-version-label re-upload, a FOMOD-only choices
      // change) has NO checkbox at all -- it just updates automatically, nothing to offer. Gemini pass
      // (queue item ucv2-review-tooltips-copy, landed 2026-08-26) -- see
      // design/gemini-ucv2-review-tooltips-prompt.md for the prompt this came from.
      const keepTooltip = 'The collection includes an older version than what you have. Check this to skip the downgrade and keep your current, newer version instead.';
      const keepCell = !ucv2HasKeepChoice(u) ? '' : `<label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer" title="${escHtmlUcv2(keepTooltip)}"><input type="checkbox" data-ucv2-keep-modid="${escHtmlUcv2(modId)}" ${u.installedIsNewer ? 'checked' : ''}><span>Keep installed${note}</span></label>`;
      // Its OWN explicit check, separate from ucv2HasKeepChoice -- that's narrowed to the downgrade
      // case only now, so it's true for a lot more than just "same version label" (every plain
      // upgrade too, which needs no tooltip -- the arrow already says everything). Gemini pass (queue
      // item ucv2-review-tooltips-copy, landed 2026-08-26).
      const sameVersionLabel = String(fromVersion ?? '').trim().toLowerCase() === String(u.new.version ?? '').trim().toLowerCase();
      const versionTooltip = sameVersionLabel
        ? "Not a glitch! The version number didn't change, but the author updated the actual file, so it'll update automatically." : undefined;
      return ucv2RowHtml(u.disabled ? 'Disabled' : 'Update', u.disabled ? 'status-pill--disabled' : 'status-pill--info', u.new.name, `${ucv2VersionLabel(fromVersion)} → ${ucv2VersionLabel(u.new.version)}`, keepCell, u.new.author, u.new.instructions, undefined, modId, u.mergedPluginFlag, versionTooltip, u.new.source?.type === 'bundle');
    }),
    ...r.added.map((m) => ucv2RowHtml(m.disabled ? 'Disabled' : 'New', m.disabled ? 'status-pill--disabled' : 'status-pill--success', m.name, ucv2VersionLabel(m.version), '', m.author, m.instructions, undefined, ucv2AddedModId(m), m.mergedPluginFlag, undefined, m.source?.type === 'bundle')),
    // Ignored (2026-08-30, real Vortex-confirmed status, rule.ignored === true) -- never processed by
    // Apply (see reviewUpdateCore's own ignoredAdded computation, server-side), so no modKey/live
    // progress tracking is needed the way a real Added row gets one.
    ...r.ignored.map((m) => ucv2RowHtml('Ignored', 'status-pill--ignored', m.name, ucv2VersionLabel(m.version), '', m.author, m.instructions, undefined, undefined, undefined, undefined, m.source?.type === 'bundle')),
    // Disabled mods out of the Unchanged bucket (2026-08-30, director-caught real UX gap): a Disabled
    // mod IS a real change from this screen's own point of view (it needs re-disabling once the
    // update finishes, same Phase 2b restoration every other Disabled row already relies on) --
    // burying it behind "Show unchanged mods" reads as if nothing's happening to it. Shown here,
    // always visible, same as every other genuinely-changing row; only a truly untouched mod (no file
    // change AND currently enabled) stays in the collapsed section below.
    ...r.unchanged.filter((m) => m.disabled).map((m) => ucv2RowHtml('Disabled', 'status-pill--disabled', m.name, m.version ? ucv2VersionLabel(m.version) : '', '', m.author, m.instructions)),
  ];
  // Unchanged (2026-08-18) -- listed too now, but collapsed behind a toggle by default (same
  // collapsed-by-default idea as this app's other "lowest-priority content" lists, e.g.
  // .chip-list-details/.sync-list-toggle), since these mods need no action from you and a 25-mod
  // collection with 20 unchanged would otherwise bury the rows that actually matter under a wall of
  // "Installed" pills. Real rows in the SAME table (not a separate list) so the total row count still
  // reconciles against the collection's real mod count once expanded. Disabled mods excluded here --
  // see the `rows` array above, they're always-visible now, not collapsed.
  const trulyUnchanged = r.unchanged.filter((m) => !m.disabled);
  const unchangedRows = trulyUnchanged.length === 0 ? [] : [
    `<tr class="ucv2-unchanged-toggle-row"><td colspan="6"><a class="sync-list-toggle" `
      + `data-more="▾ Show ${trulyUnchanged.length} unchanged mod${trulyUnchanged.length === 1 ? '' : 's'} (already installed)" `
      + `data-less="▴ Hide unchanged mods">▾ Show ${trulyUnchanged.length} unchanged `
      + `mod${trulyUnchanged.length === 1 ? '' : 's'} (already installed)</a></td></tr>`,
    ...trulyUnchanged.map((m) => ucv2RowHtml('Installed', 'status-pill--neutral', m.name, m.version ? ucv2VersionLabel(m.version) : '', '', m.author, m.instructions, 'ucv2-unchanged-row hidden')),
  ];
  $ucv2('ucv2ReviewTableBody').innerHTML = [...rows, ...unchangedRows].join('');
  ucv2RenderReviewFilterBadges(r, rows.length);
  // "Keep installed?" only ever applies to Updated rows -- an Added-only review (no updates at all)
  // has nothing to put in that column, so hide it rather than showing a dead, empty header. Same
  // check drives the Select-all/Invert/Clear bar below -- a FOMOD-choices-only update or a
  // same-version-label re-upload has no "Keep installed" checkbox at all (see ucv2HasKeepChoice), so
  // a revision where EVERY updated mod falls into one of those used to still show the column and the
  // selection bar with nothing real to select -- confirmed confusing live, 2026-08-23 (and again 2026-08-26
  // for the same-version-label case).
  const hasRealKeepChoices = r.updated.some(ucv2HasKeepChoice);
  document.querySelectorAll('#ucv2ReviewTableWrap .ucv2-keep-col')
    .forEach((el) => el.classList.toggle('hidden', !hasRealKeepChoices));
  const anyRows = rows.length > 0 || r.unchanged.length > 0;
  $ucv2('ucv2ReviewTableWrap').classList.toggle('hidden', !anyRows);
  $ucv2('ucv2ReviewEmpty').classList.toggle('hidden', anyRows);
  if (!anyRows) $ucv2('ucv2ReviewEmpty').textContent = "Nothing to show here for this update.";
  $ucv2('ucv2KeepSelectionBar').classList.toggle('hidden', !hasRealKeepChoices);
  ucv2UpdateKeepCount();
}

// Status filter pills (2026-08-28, director's own catch: "we don't have our pill filters, like our
// other tools") -- DESIGN.md's own app-wide "click stats to filter a list" convention
// (.badge--clickable + data-status, multi-select), same mechanism Stats/Work Through/the Ignored-
// Disabled report/Update Compare/Missing Masters/Archive Finder/Merge review already use. Only three
// pills (Update/New/Remove, director's own explicit scope) -- Keep/Installed rows still carry a real
// data-status (ucv2RowHtml above) so they correctly hide too once any OTHER pill is active, they just
// have no pill of their own to select them back.
let ucv2ReviewActiveFilters = new Set();
function ucv2ReviewFilterCounts(r) {
  const removeCount = r.removed.filter((m) => !ucv2KeepRemovedModIds.has(ucv2RemovedModId(m))).length;
  // Disabled (2026-08-30) overrides whichever of Update/New/Installed a row would otherwise show
  // (see the row-builders above) -- counts here match that same override, so a pill's own count
  // always equals how many rows actually render under it.
  const updateCount = r.updated.filter((u) => !u.disabled).length;
  const newCount = r.added.filter((m) => !m.disabled).length;
  const disabledCount = [...r.updated, ...r.added, ...r.unchanged].filter((m) => m.disabled).length;
  return { update: updateCount, new: newCount, remove: removeCount, ignored: r.ignored.length, disabled: disabledCount };
}
function ucv2RenderReviewFilterBadges(r, realRowCount) {
  const container = $ucv2('ucv2ReviewFilterBadges');
  // Fresh render always starts unfiltered, same as this app's other Set-based status filters
  // (app.js's own planStatusFilter.clear() on a fresh plan render).
  ucv2ReviewActiveFilters.clear();
  container.classList.toggle('hidden', realRowCount === 0);
  if (realRowCount === 0) { container.innerHTML = ''; return; }
  const counts = ucv2ReviewFilterCounts(r);
  const active = (s) => ucv2ReviewActiveFilters.has(s) ? ' badge--filter-active' : '';
  container.innerHTML = [
    `<span class="badge badge--show-all badge--filter-active" data-status="__all__">Show all</span>`,
    `<span class="badge badge--info badge--clickable${active('update')}" data-status="update"><span class="dot"></span>Update <span class="badge__count">(${counts.update})</span></span>`,
    `<span class="badge badge--success badge--clickable${active('new')}" data-status="new"><span class="dot"></span>New <span class="badge__count">(${counts.new})</span></span>`,
    `<span class="badge badge--critical badge--clickable${active('remove')}" data-status="remove"><span class="dot"></span>Remove <span class="badge__count">(${counts.remove})</span></span>`,
    // Ignored/Disabled (2026-08-30, director-caught real bug -- see reviewUpdateCore's own
    // ignoredAdded/isDisabledMod header comments for the full writeup) -- real Vortex statuses, not
    // generic New/Update. Reuses this app's own already-established Ignored/Disabled badge pair
    // (web/public/styles.css .badge--ignored/.badge--disabled) rather than inventing new colors.
    `<span class="badge badge--ignored badge--clickable${active('ignored')}" data-status="ignored"><span class="dot"></span>Ignored <span class="badge__count">(${counts.ignored})</span></span>`,
    `<span class="badge badge--disabled badge--clickable${active('disabled')}" data-status="disabled"><span class="dot"></span>Disabled <span class="badge__count">(${counts.disabled})</span></span>`,
  ].join('');
}
function ucv2ApplyReviewFilter() {
  document.querySelectorAll('#ucv2ReviewFilterBadges .badge').forEach((b) => {
    const isAll = b.dataset.status === '__all__';
    b.classList.toggle('badge--filter-active', isAll ? ucv2ReviewActiveFilters.size === 0 : ucv2ReviewActiveFilters.has(b.dataset.status));
  });
  document.querySelectorAll('#ucv2ReviewTableBody tr[data-status]').forEach((row) => {
    const show = ucv2ReviewActiveFilters.size === 0 || ucv2ReviewActiveFilters.has(row.dataset.status);
    row.classList.toggle('ucv2-row-filtered-out', !show);
  });
}
$ucv2('ucv2ReviewFilterBadges').addEventListener('click', (e) => {
  const badge = e.target.closest('.badge');
  if (!badge) return;
  const status = badge.dataset.status;
  if (status === '__all__') ucv2ReviewActiveFilters.clear();
  else if (ucv2ReviewActiveFilters.has(status)) ucv2ReviewActiveFilters.delete(status);
  else ucv2ReviewActiveFilters.add(status);
  ucv2ApplyReviewFilter();
});

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
  // Per-mod now -- two separate counts instead of one all-or-nothing line, since some removed mods
  // can be kept while others get uninstalled in the same apply.
  const keepRemovedCount = r.removed.filter((m) => ucv2KeepRemovedModIds.has(ucv2RemovedModId(m))).length;
  const toRemoveCount = r.removed.length - keepRemovedCount;
  const removedNote = toRemoveCount > 0 ? `<li><strong>${toRemoveCount}</strong> mod${toRemoveCount === 1 ? '' : 's'} will be fully uninstalled.</li>` : '';
  // Split out from removedNote (2026-08-28, director's own ask) -- rendered at the bottom of the
  // list alongside keepNote below, since both describe a mod that's deliberately NOT changing this
  // apply rather than a real action about to happen, unlike every bullet above them.
  const removedKeptNote = keepRemovedCount > 0
    ? `<li><strong>${keepRemovedCount}</strong> removed mod${keepRemovedCount === 1 ? '' : 's'} will remain installed, but ${keepRemovedCount === 1 ? 'it' : 'they'} will no longer be tracked as part of this collection.</li>`
    : '';
  const addedNote = r.added.length === 0 ? ''
    : `<li><strong>${r.added.length}</strong> new mod${r.added.length === 1 ? '' : 's'} will be installed.</li>`;
  const keptCount = ucv2KeepInstalledModIds.size;
  const toUpdateCount = r.updated.length - keptCount;
  const keepNote = keptCount === 0 ? ''
    : `<li><strong>${keptCount}</strong> mod${keptCount === 1 ? '' : 's'} will be kept at ${keptCount === 1 ? 'its' : 'their'} currently installed version${keptCount === 1 ? '' : 's'} (per your choice) and will not be updated.</li>`;
  // Folded into the main bullet list (2026-08-28, director's own simplification -- was previously a
  // separate .callout--warning block with the full file list, same bar Mod Scrub's own delete
  // confirmation sets; the director asked for it collapsed to a single line here instead).
  const archiveDeleteNote = (ucv2DeleteArchives && r.removed.length > 0)
    ? `<li><strong>${r.removed.length}</strong> archive${r.removed.length === 1 ? '' : 's'} will be deleted.</li>`
    : '';
  // "External Changes" dialog heads-up (2026-08-18, widened 2026-08-29) -- a real, repeatedly-
  // confirmed Vortex behavior, not a bug: this tool writes mod files directly to disk (bypassing
  // InstallManager, same as every real write here), so Vortex's own file-watcher genuinely has no
  // prior record for them and surfaces its real "External Changes" dialog during the deploy that
  // follows. Traced this all the way to Vortex's own real source (classifyExternalChange,
  // mod_management/util/externalChanges.ts): a genuine Vortex-driven collection install suppresses
  // this automatically via InstallManager.markRecentInstall(), but that method has no public
  // context.api.ext surface -- there is no way to trigger the same suppression from outside Vortex's
  // own process without patching Vortex itself, which this project doesn't do. Since the dialog can't
  // be prevented, the honest next-best fix is telling the user what to expect and that the answer is
  // always safe, rather than leaving it as an unexplained interruption. Originally scoped to Added
  // mods only (new staging folders Vortex's watcher has never seen) -- widened to also cover a real
  // Updated-mod write (director-confirmed live: re-extracting a NEW revision's files into an
  // EXISTING, already-known staging folder can trigger the same dialog too, since the folder's
  // CONTENT just changed even though the folder itself isn't new to the watcher). Uses toUpdateCount,
  // not r.updated.length -- a mod the director chose to Keep at its current version never gets
  // touched, so it can't trigger this regardless of which bucket it's counted in.
  const externalChangesNote = (r.added.length === 0 && toUpdateCount <= 0) ? '' : `<div class="callout callout--warning" style="margin:14px 0">`
    + `<div class="callout__title">⚠️ Vortex may ask about "External Changes"</div>`
    + `Installing or updating mods may trigger Vortex's "External Changes" dialog -- this is completely `
    + `normal. Because this tool writes mod files directly, Vortex detects new or changed files it `
    + `hasn't seen yet. Simply select <strong>Use newer file</strong> (the default option) and continue `
    + `so the updated files take priority.</div>`;
  // No real mod-level changes this revision (2026-08-28, director's own catch) -- same "nothing in
  // the mod list, but rules/metadata may still differ" case the Review screen's own tip banner
  // already covers (see ucv2RenderReviewScreen's noChanges). "0 mods will be updated" read as if
  // this apply does nothing at all, when it can genuinely still rewrite collection rules.
  const totalChanged = r.updated.length + r.added.length + r.removed.length;
  body.innerHTML = `<p>A backup will be taken first. Then:</p><ul style="margin:0;padding-left:20px">`
    + (totalChanged === 0
      ? `<li>Rules or metadata.</li>`
      : `<li><strong>${toUpdateCount}</strong> mod${toUpdateCount === 1 ? '' : 's'} will be updated.</li>` + removedNote + addedNote)
    + archiveDeleteNote
    + keepNote + removedKeptNote
    + `</ul>` + externalChangesNote
    + `<p style="margin-bottom:0">Keep Vortex open with the Vortex Bridge active to complete the process.</p>`;
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
  // Returns HTML for innerHTML: every outside part is escaped here (the text comes from the collection author).
  if (/^\d/.test(clean)) return `version ${escHtmlUcv2(clean)} exactly`;
  const ge = clean.match(/^>=\s*([\d.]+)$/);
  if (ge) return `version ${ge[1]} or newer`;
  const gt = clean.match(/^>\s*([\d.]+)$/);
  if (gt) return `a version newer than ${gt[1]}`;
  const range = clean.match(/^>=\s*([\d.]+)\s*<\s*([\d.]+)$/);
  if (range) return `a version from ${range[1]} up to (but not including) ${range[2]}`;
  return `a version matching "${escHtmlUcv2(clean)}"`;
}

// One line per broken mod inside its own dependent's group -- the group heading already names the
// dependent (b.dependentName), so this only needs the mod + version change itself.
function ucv2DependencyBreakLine(b) {
  return `<li style="margin-bottom:6px"><strong>${escHtmlUcv2(b.updatedModName)}</strong> — needs `
    + `${ucv2FormatVersionMatch(b.versionMatch)}, but this update changes it from version ${escHtmlUcv2(b.oldVersion || '?')} to `
    + `<strong>${escHtmlUcv2(b.newVersion || '?')}</strong>.</li>`;
}

// Grouped by dependent (2026-08-30, director's own spec) -- same collapsible-group pattern (native
// <details>/<summary>, .chip-list-details' own rotating caret) every other real "show me the detail"
// list in this app already uses (cycle-helper-app.js's own tangle list, rules-generator-app.js's own
// no-link list), reused as-is rather than inventing a new one. A real collection commonly has several
// mods breaking the SAME dependent (GTS - PBR Visual Overhaul showed up 3 times in one real Gate To
// Sovngarde test) -- flattening that into one bullet per break, as before, repeated the dependent's
// own name three times in a row instead of grouping what's actually the same underlying story.
function ucv2DependencyBreakGroupHtml(dependentName, breaks) {
  return `<details class="chip-list-details"><summary><span class="chip-list-details__caret">▸</span> `
    + `<strong>${escHtmlUcv2(dependentName)}</strong> <span class="chip-list-details__count">(${breaks.length})</span></summary>`
    + `<div class="chip-list-details__body"><ul style="margin:0;padding-left:20px;font-size:13px">${breaks.map(ucv2DependencyBreakLine).join('')}</ul></div></details>`;
}

let ucv2PendingDependencyBreaks = [];

function ucv2ShowDependencyBreakModal(breaks) {
  ucv2PendingDependencyBreaks = breaks;
  const body = $ucv2('ucv2DependencyBreakBody');
  const byDependent = new Map();
  breaks.forEach((b) => {
    const key = b.dependentName || 'Unknown';
    if (!byDependent.has(key)) byDependent.set(key, []);
    byDependent.get(key).push(b);
  });
  const groupsHtml = [...byDependent.entries()].map(([name, group]) => ucv2DependencyBreakGroupHtml(name, group)).join('');
  body.innerHTML = `<p>${breaks.length} mod${breaks.length === 1 ? '' : 's'} depend${breaks.length === 1 ? 's' : ''} on something this update changes in a way that breaks the dependency:</p>`
    + groupsHtml
    + `<p style="margin:12px 0 0">Selecting <strong>Ignore</strong> marks these dependency rules as acknowledged so you won't be warned again (matching Vortex's default behavior). Alternatively, select <strong>Keep My Installed Version</strong> to leave the affected mods untouched and prevent dependency breaks entirely.</p>`;
  $ucv2('ucv2DependencyBreakModal').classList.add('open');
}
$ucv2('ucv2DependencyBreakClose').addEventListener('click', () => $ucv2('ucv2DependencyBreakModal').classList.remove('open'));
$ucv2('ucv2DependencyBreakCancel').addEventListener('click', () => {
  $ucv2('ucv2DependencyBreakModal').classList.remove('open');
  ucv2SetApplyBtnState(false, 'Apply Update →');
  // This gate is only ever reachable from the main Apply flow (findBrokenDependencies is never called
  // from prepareApplyOptional), so Review is always the right screen to return to -- unlike the FOMOD
  // picker's own multi-flow returnScreenId, no ambiguity to resolve here. Same reasoning as
  // ucv2CloseFomodPicker: this gate can now arrive via the Apply Progress stream, not only while
  // still sitting on Review -- a no-op if we're already there.
  ucv2GoScreen('ucv2Screen2');
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
  ucv2PendingDependencyBreaks.forEach((b) => { if (b.key) ucv2IgnoredDependencyBreakKeys.add(b.key); });
  ucv2ConfirmApply();
});

// FOMOD picker moved to web/public/fomod-picker.js 2026-09-17 ("Open FOMOD mods get an Install
// button") -- Rebuild Missing Files and Rebuild Collection now drive the SAME shared component
// for their own new Install action against a real Open FOMOD row. showFomodPicker(needs, {onDone,
// onCancel}) is the new public entry point; see that file's own header comment for the full API.
// ucv2FomodPicks (declared near the top of this file) is still this file's OWN cross-retry
// accumulator -- the shared picker itself holds no opinion on what a caller does with finished
// picks, it just hands them back via onDone(picksByModId).

// Real, live streamed progress (2026-08-21) -- mirrors pgpatcher-app.js's own pgpatcherBuild/
// pgpHandleBuildEvent shape exactly: POST kicks off the real work and returns immediately, a paired
// GET /apply/events streams real phase/progress as it happens, this subscribes instead of blocking on
// one long request. Supersedes the old ucv2StartApplyProgressPolling/GET /apply-progress side-channel
// entirely (that only ever covered the final deploy step; this covers every real phase).
let ucv2ApplyEventSource = null;

function ucv2FinishApplyStream() {
  if (ucv2ApplyEventSource) { ucv2ApplyEventSource.close(); ucv2ApplyEventSource = null; }
  ucv2StopApplyStallPolling();
  ucv2SetApplyBtnState(false, 'Apply Update →');
  $ucv2('ucv2Loading').classList.add('hidden');
}

// Now targets the dedicated Apply Progress screen's own phase-indicator text (2026-08-28) -- the old
// inline #ucv2ApplyProgress callout on the Review screen is gone; progress lives entirely on its own
// screen now, matching the mockup's own #applyPhaseText.
// indeterminate (2026-10-23): a step with no real count (a pause, one big read) fills the bar to the app's
// "mostly full" look (the Remove Collection convention) instead of resetting it to empty.
function ucv2SetApplyPhase(message, current, total, indeterminate) {
  $ucv2('ucv2ApplyProgressPhaseText').textContent = current && total ? `${current} / ${total} — ${message}` : message;
  // Fill bar now tracks whatever phase is actually running (2026-08-30, director's own catch: it sat
  // frozen at 0% through prepareApply's own real, multi-minute pre-flight scan since only mod-complete
  // ever bumped it before -- that phase has no mod rows to complete at all). A bare 'phase' frame
  // (current/total both undefined) resets it to 0% for the new phase about to start; a 'progress'
  // frame sets it directly from THAT phase's own real current/total -- a genuinely different scale
  // than ucv2ApplyProgressTotal (the real per-mod write count), not something to reconcile with it.
  // The real write phase's own mod-complete handler (ucv2BumpApplyProgressBar) takes back over once
  // it starts firing, same as before.
  $ucv2('ucv2ApplyProgressFill').style.width = current && total ? `${Math.round((current / total) * 100)}%` : (indeterminate ? '90%' : '0%');
}

// Real status vocabulary/colors (2026-08-28, director's own build spec) -- every pill here renders
// through ucv2ApplyPillHtml, the ONE shared lookup (update-collection-v2-apply-pills.js). See that
// file's own header comment for why Downloading/Installing get distinct colors and Enabled is a real
// filled pill, both deliberate overrides of real Vortex's own convention.
// Carries out what ucv2ApplyTracker decided (see update-collection-v2-apply-rows.js). A failed row keeps its
// real pill and message; a finished one fades out; a row the run never touched says so (settle()).
function ucv2RunApplyRowOps(ops) {
  for (const o of ops) {
    if (o.op === 'top') ucv2MoveApplyProgressRowToTop(o.index);
    else if (o.op === 'pill') ucv2UpdateApplyProgressRow(o.index, o.key, o.label, o.title);
    else if (o.op === 'remove') ucv2RemoveApplyProgressRow(o.index);
    else if (o.op === 'failed') {
      const rowKind = (ucv2ApplyProgressRowData[o.index] || {}).kind;
      // A known failure status (status-labels.js's own STATUS_TEXT table, shared with Stats Report/Rebuild
      // Collection so a raw internal key never leaks to the user) gets its real label instead of a flat
      // "Failed"; a failed Remove row shows its own message as the label (unchanged from before).
      const knownLabel = o.status && STATUS_TEXT[o.status] ? statusLabel(o.status) : null;
      const label = rowKind === 'remove' ? (o.error || 'Failed') : (knownLabel || 'Failed');
      ucv2UpdateApplyProgressRow(o.index, 'failed', label, o.error || undefined);
    }
  }
}

function ucv2HandleApplyEvent(frame) {
  ucv2ApplyLastEventAt = Date.now(); // resets the SSE-quiet fallback timer -- see ucv2StartApplyStallPolling
  if (frame.type === 'phase') {
    ucv2SetApplyPhase(frame.message, undefined, undefined, frame.indeterminate === true);
  } else if (frame.type === 'progress') {
    ucv2SetApplyPhase(frame.message, frame.current, frame.total);
  } else if (frame.type === 'mod-start') {
    // Remove rows get their own real "Removing…" state right here -- a genuinely new capability
    // (2026-08-28); these previously had ZERO live per-mod status at all. Updated/Added rows get NO
    // visual change on mod-start -- they stay showing "Download pending" until the first real
    // mod-phase event, matching the mockup's own real behavior (mod-start isn't a distinct visual
    // state there either, only downloading/installing/enabled are).
    if (ucv2ApplyTracker) ucv2RunApplyRowOps(ucv2ApplyTracker.apply(frame));
  } else if (frame.type === 'mod-phase') {
    // Refined per-row sequence (2026-08-28, director's own build spec): Download pending ->
    // Downloading... -> Extracting... -> Pending install -> Installing... [whole batch, together] ->
    // Enabled. The frame -> pill mapping lives in the tracker (update-collection-v2-apply-rows.js's
    // PHASE_PILL) so it's tested: 'downloading'/'installing' are rebuildSingleMod's own onPhase callback
    // ('installing' there means THIS mod's own extraction, so it renders as the 'extracting' pill);
    // 'pending-install'/'batch-installing' come from the Added-mod loop in lib/update-collection-v2-runner.js.
    if (ucv2ApplyTracker) ucv2RunApplyRowOps(ucv2ApplyTracker.apply(frame));
  } else if (frame.type === 'mod-complete') {
    ucv2BumpApplyProgressBar();
    // A Remove row that genuinely succeeded (or was skipped/already-done) fades and vanishes; so does an
    // Updated/Added row that succeeded (2026-08-30 -- with hundreds of rows a settled one just buries what's
    // still happening; the full list comes back on ucv2RenderApplyResult). A FAILED row stays put with a real
    // pill -- never silently hidden.
    if (ucv2ApplyTracker) ucv2RunApplyRowOps(ucv2ApplyTracker.apply(frame));
  } else if (frame.type === 'mods-settled') {
    // Sent by the server the moment every per-mod step is finished, well before the long tail (collection
    // rules, membership cleanup, ...) -- gives every row still on screen its real final state from the run's
    // own results, so nothing sits on "Download pending" once its mod is actually done (2026-09-28).
    if (ucv2ApplyTracker) ucv2RunApplyRowOps(ucv2ApplyTracker.settle(frame));
  } else if (frame.type === 'done') {
    if (ucv2ApplyTracker && frame.result) ucv2RunApplyRowOps(ucv2ApplyTracker.settle(frame.result));
    ucv2FinishApplyStream();
    // frame.optional (2026-08-28) -- set by the /apply-optional route's own 'done' frame, distinct
    // from the main /apply route's own (which never sets it, so this is falsy there). Both land on
    // the same rich ucv2RenderApplyResult, just with the optional-mods decision block suppressed the
    // second time -- that choice is already made.
    ucv2RenderApplyResultChecked(frame.result, !!frame.optional);
  } else if (frame.type === 'error') {
    ucv2FinishApplyStream();
    // The dependency-break/FOMOD-choice/bridge-unavailable gates now run AFTER the stream starts for
    // BOTH /apply (2026-08-30) and /apply-optional (2026-08-31, diagnostics/2026-08-30-real-apply-
    // marathon-findings.md finding #5, prepareApply/prepareApplyOptional's own onProgress threading --
    // see either function's header comment for why: the old synchronous-before-202 shape meant this
    // whole pre-flight phase, including a real multi-minute archive scan, showed zero progress). They
    // arrive as error frames here instead of a synchronous POST rejection now -- same real codes
    // ucv2HandleError already knows how to render for every OTHER route in this app, just reached via
    // the stream for these two. frame.optional (set on every /apply-optional error frame, same flag
    // its own 'done' frame already carries) routes the retry + return-screen to the Optional Installs
    // flow instead of the main one -- getting this wrong would silently retry/redirect the wrong pass.
    const isOptional = !!frame.optional;
    const retry = isOptional ? () => ucv2StartOptionalApply(ucv2LastOptionalApplyMods) : () => ucv2ConfirmApply();
    const returnScreen = isOptional ? 'ucv2ScreenOptionalInstalls' : 'ucv2Screen2';
    if (frame.code === 'dependency-breaks-found') {
      ucv2ShowDependencyBreakModal(frame.dependencyBreaks || []);
      return;
    }
    if (frame.code === 'fomod-choices-needed') {
      // Shared picker (web/public/fomod-picker.js) hands back this session's OWN picks directly
      // (picksByModId) instead of relying on it to have mutated a shared global itself -- merge into
      // this file's own cross-retry accumulator (a FOMOD gate can fire more than once across one
      // overall apply attempt) before re-running the exact same retry the gate itself already needed.
      showFomodPicker(frame.fomodChoiceNeeds || [], {
        onIgnoreValidation: (need) => {
          // No single-mod recheck endpoint exists for this batched gate -- record the override and
          // re-run the WHOLE apply request from scratch (this file's own existing retry mechanism,
          // already idempotent across FOMOD gate round-trips via ucv2FomodPicks). prepareApply/
          // prepareApplyOptional will then either resolve this mod straight through (if a pick was
          // already supplied for it) or reopen a fresh picker for its normal 'open'/'mismatch'
          // choices -- returning a falsy value here tells fomod-picker.js this session is handling
          // its own next step, so it must not try to continue this SAME modal in place.
          ucv2IgnoreFomodValidationModIds = new Set([...ucv2IgnoreFomodValidationModIds, need.modId]);
          hideFomodPickerModal();
          retry();
          return null;
        },
        onDone: (picksByModId) => {
          ucv2FomodPicks = { ...ucv2FomodPicks, ...picksByModId };
          retry();
        },
        onCancel: () => {
          ucv2SetApplyBtnState(false, 'Apply Update →');
          // Only navigates when a caller actually supplied one (a no-op otherwise, matching the old
          // ucv2FomodPickerReturnScreenId behavior for any call site that never needed this).
          if (returnScreen) ucv2GoScreen(returnScreen);
        },
      });
      return;
    }
    if (frame.code === 'bridge-unavailable') {
      window.showBridgeUnavailableModal(retry);
      return;
    }
    // BACKUP_FAILED (2026-09-01, director's own exact copy, live-caught: the generic "Couldn't do
    // that" title undersold a real hard abort -- no safety backup means the apply genuinely never
    // started, not just "something didn't work").
    // Vortex differs from what was confirmed (nothing was written): say so and offer the one way forward. New words need their Gemini pass.
    if (frame.code === 'review-changed') {
      ucv2SetApplyBtnState(false, 'Apply Update →');
      ucv2ShowCriticalError(frame.message || 'Vortex changed since you reviewed.', () => { const id = ucv2ActiveReviewModId || (ucv2CurrentReview && ucv2CurrentReview.collectionModId); ucv2ActiveReviewModId = null; if (id) ucv2StartReview(id); }, '⚠️ Vortex changed', 'Review again');
      return;
    }
    if (frame.code === 'BACKUP_FAILED') {
      ucv2ShowCriticalError(frame.message || 'The apply failed.', retry, '🛑 Update Aborted: Backup Failed');
      return;
    }
    ucv2ShowCriticalError(frame.message || 'The apply failed.');
  }
}

async function ucv2ConfirmApply(extra) {
  $ucv2('ucv2ApplyConfirmModal').classList.remove('open');
  ucv2HideCriticalError();
  ucv2SetApplyBtnState(true, 'Applying…');
  ucv2ShowLoading(UCV2_LOADING_TEXT_ONE_COLLECTION);
  let result;
  try {
    // 202 with an empty body as soon as basic validation + the single-apply-at-a-time guard clear
    // (2026-08-30) -- prepareApply's own gates (dependency-break, FOMOD-choice, bridge-unavailable)
    // used to be checked synchronously BEFORE this ever returned, which is exactly why they used to
    // arrive as a 409 here. They now run AFTER the stream starts (see routes.js's own /apply handler
    // and prepareApply's own onProgress threading) so their own real archive-scanning work is finally
    // visible instead of a multi-minute silent "Applying..." -- they arrive as error frames via
    // GET /apply/events now, handled in ucv2HandleApplyEvent's own 'error' branch, not here.
    result = await ucv2Api('POST', '/api/update-collection-v2/apply', {
      collectionModId: ucv2ActiveReviewModId,
      // Whatever revision this review actually reviewed -- the true newest by default, or a manual
      // older pick from the revision dropdown (2026-08-27). Always sent, not just after a manual
      // pick: the backend's own prepareApply does its own fresh re-review right before writing, and
      // without this it silently re-resolves to the true newest instead of the SAME revision the
      // director's own per-mod decisions on this screen (keep-installed, removed keep/remove, FOMOD
      // choices) were actually made against.
      targetRevisionNumber: ucv2CurrentReview.newRevisionNumber,
      // The lists the person confirmed, so the server can check Vortex still matches them (it never trusts them as the work list).
      confirmed: {
        updated: ucv2CurrentReview.updated.map(ucv2UpdatedModId),
        added: ucv2CurrentReview.added.map(ucv2AddedModId),
        removed: ucv2CurrentReview.removed.map(ucv2RemovedModId),
      },
      includeOlderInstalled: ucv2CurrentReview.olderIncluded === true,
      keepRemovedModIds: [...ucv2KeepRemovedModIds],
      keepInstalledModIds: [...ucv2KeepInstalledModIds],
      deleteArchives: ucv2DeleteArchives,
      fomodPicks: ucv2FomodPicks,
      ignoreFomodValidationModIds: [...ucv2IgnoreFomodValidationModIds],
      ignoredDependencyBreakKeys: [...ucv2IgnoredDependencyBreakKeys],
      ...(extra || {}),
    });
  } catch (e) {
    ucv2SetApplyBtnState(false, 'Apply Update →');
    $ucv2('ucv2Loading').classList.add('hidden');
    // A real retry, not a no-op -- re-runs this SAME apply call (same extra flags, e.g. a
    // dependency-break already resolved earlier in this attempt), needed for the new
    // bridge-unavailable modal's own "Try Again" to genuinely do something (2026-08-18: this was a
    // pre-existing no-op here, which would have silently carried over into that modal too).
    ucv2HandleError(e, () => ucv2ConfirmApply(extra));
    return;
  }
  // The POST resolved 202 -- a real apply is genuinely running server-side now (prepareApply's own
  // gates included -- they may still refuse it a moment later via the stream, see above). Navigate to
  // the dedicated Apply Progress screen (2026-08-28) BEFORE subscribing -- every row starts "Download
  // pending"/no pill mutation happens until a real frame arrives, so there's no risk of a frame
  // racing ahead of the table existing in the DOM.
  const r = ucv2CurrentReview;
  // "Rev {N}" alone here, not the M→N range ucv2RevisionLabel() uses elsewhere -- matches the
  // mockup's own exact title spec ("Applying updates to {collection} — Rev {N}"), the revision
  // actually being applied TO, not the range being applied FROM.
  ucv2RenderApplyProgressScreen(ucv2BuildMainApplyRows(), `Applying updates to ${r.collectionName} — Rev ${r.newRevisionNumber ?? '?'}`, r.pictureUrl);
  // Subscribe to the stream (mirrors pgpatcherLoad's own EventSource setup exactly).
  if (ucv2ApplyEventSource) ucv2ApplyEventSource.close();
  const es = new EventSource('/api/update-collection-v2/apply/events');
  ucv2ApplyEventSource = es;
  es.onmessage = (msg) => ucv2HandleApplyEvent(JSON.parse(msg.data));
  ucv2StartApplyStallPolling();
}
// A fresh apply started from the review: an earlier "Ignore" never covers it.
$ucv2('ucv2ApplyConfirmOk').addEventListener('click', () => { ucv2IgnoredDependencyBreakKeys = new Set(); ucv2ConfirmApply(); });

// Per-problem Retry (2026-08-23) -- ucv2ProblemMessageHtml is split out from ucv2ProblemLineHtml so a
// failed retry can rebuild just the message span in place (see the click handler below) without
// re-rendering the whole <li> (which would also mean re-attaching its own Retry button state).
function ucv2ProblemMessageHtml(label, name, message) {
  return `<strong>${escHtmlUcv2(label)}${name ? ` — ${escHtmlUcv2(name)}` : ''}:</strong> ${escHtmlUcv2(message || 'Failed.')}`;
}

// A mod that needs a FOMOD choice gets "Choose" (the FOMOD picker opens right there), every other row "Retry" (2026-10-24).
const UCV2_FOMOD_NEEDED_TEXT = 'Needs a FOMOD choice.';
function ucv2RetryButtonLabel(message) {
  return message === UCV2_FOMOD_NEEDED_TEXT ? 'Choose' : 'Retry';
}

function ucv2ProblemLineHtml(p, i) {
  const msgHtml = ucv2ProblemMessageHtml(p.label, p.name, p.message);
  if (!p.retry) return `<li>${msgHtml}</li>`;
  const modIdAttr = p.retry.modId ? ` data-ucv2-retry-modid="${escHtmlUcv2(p.retry.modId)}"` : '';
  return `<li data-ucv2-problem-index="${i}" data-ucv2-problem-label="${escHtmlUcv2(p.label)}" data-ucv2-problem-name="${escHtmlUcv2(p.name || '')}" style="display: flex; align-items: center; gap: 12px; justify-content: space-between;">`
    + `<span class="ucv2-problem-text">${msgHtml}</span>`
    + `<button type="button" class="btn btn--ghost btn--small ucv2-problem-retry" data-ucv2-retry-kind="${escHtmlUcv2(p.retry.kind)}"${modIdAttr}>${ucv2RetryButtonLabel(p.message)}</button>`
    + `</li>`;
}

// Grouped form of ucv2ProblemLineHtml (2026-08-28) -- used ONLY for the six per-mod categories
// (see UCV2_GROUPED_PROBLEM_LABELS/ucv2GroupProblems in update-collection-v2-problem-grouping.js).
// Drops the "{label} — {name}:" prefix entirely -- the group's own heading already says what
// happened, repeating it on every line was the director's own real complaint (a real screenshot: 17
// "Remove — Modname: Failed." lines under one "Applied with some problems" title). Just the mod
// name, muted (this app's own existing .muted class) -- plus a real, specific message when there is
// one (message is truthy), but the generic client-side "Failed." fallback is dropped entirely once
// there's no real message to show; a bare "it failed" adds nothing once it's already under a
// "couldn't be removed" heading. SAME per-<li> DOM shape as ucv2ProblemLineHtml (data attributes,
// .ucv2-problem-text span, .ucv2-problem-retry button) -- ucv2AttemptProblemRetry/
// ucv2MaybeClearApplyProblemsBadge need that shape unchanged; this only changes the label/message
// content inside it.
function ucv2GroupedProblemLineHtml(p, i, suppressMessage) {
  const nameHtml = `${escHtmlUcv2(p.name || '')}${(!suppressMessage && p.message) ? ` — ${escHtmlUcv2(p.message)}` : ''}`;
  if (!p.retry) return `<li class="muted">${nameHtml}</li>`;
  const modIdAttr = p.retry.modId ? ` data-ucv2-retry-modid="${escHtmlUcv2(p.retry.modId)}"` : '';
  return `<li data-ucv2-problem-index="${i}" data-ucv2-problem-label="${escHtmlUcv2(p.label)}" data-ucv2-problem-name="${escHtmlUcv2(p.name || '')}" style="display: flex; align-items: center; gap: 12px; justify-content: space-between;">`
    + `<span class="ucv2-problem-text muted">${nameHtml}</span>`
    + `<button type="button" class="btn btn--ghost btn--small ucv2-problem-retry" data-ucv2-retry-kind="${escHtmlUcv2(p.retry.kind)}"${modIdAttr}>${ucv2RetryButtonLabel(p.message)}</button>`
    + `</li>`;
}

// Full grouped-problems HTML (2026-08-28) -- one heading + <ul> per grouped category that actually
// has something, in ucv2GroupProblems' own fixed reading order, followed by the ungrouped
// collection-level entries (Collection rules/record/membership) rendered exactly as before, all
// inside one wrapper so ucv2MaybeClearApplyProblemsBadge's own querySelectorAll('li') (unchanged)
// still finds every real problem line regardless of nesting. Each group is its own
// .ucv2-problem-group wrapper so ucv2AttemptProblemRetry can remove a group's heading the moment its
// last <li> is gone (see that function's own small addition below), matching the flat list's own
// existing "last problem gone -> summary flips back to a plain checkmark" behavior one level down.
function ucv2ProblemsHtml(problems) {
  const { groups, ungrouped } = ucv2GroupProblems(problems);
  const groupsHtml = groups.map((g) => {
    const listHtml = `<ul style="margin:0 0 4px;padding-left:20px">${g.items.map((p, i) => ucv2GroupedProblemLineHtml(p, i, g.suppressMessage)).join('')}</ul>`;
    return `<div class="ucv2-problem-group" data-ucv2-problem-group="${escHtmlUcv2(g.label)}">`
      + `<p style="margin:10px 0 4px;font-weight:600">${escHtmlUcv2(g.heading)}</p>`
      + (g.body ? `<p style="margin:0 0 6px" data-ucv2-group-body="1">${escHtmlUcv2(g.body)}</p>` : '')
      // collapsible: same <details>/caret pattern the version-conflict window uses
      + (g.collapsible
        ? `<details class="chip-list-details"><summary><span class="chip-list-details__caret">▸</span> Show the list</summary><div class="chip-list-details__body">${listHtml}</div></details>`
        : listHtml)
      + `</div>`;
  }).join('');
  const ungroupedHtml = ungrouped.length > 0
    ? `<ul style="margin:0;padding-left:20px">${ungrouped.map(ucv2ProblemLineHtml).join('')}</ul>` : '';
  return groupsHtml + ungroupedHtml;
}

// Once every retryable problem AND every non-retryable note is gone, this apply is genuinely fully
// resolved -- hides the summary callout entirely (2026-08-28: same "nothing left to say" logic as
// ucv2RenderApplyResult's own initial-render case, rather than relabeling to a redundant "✓ Applied"
// box) without needing a full re-render (and the scroll-position jump that would come with one).
function ucv2MaybeClearApplyProblemsBadge() {
  const problemsList = document.getElementById('ucv2ApplyProblemsList');
  const notesList = document.getElementById('ucv2ApplyResultSummaryNotes');
  const stillHasProblems = problemsList && problemsList.querySelectorAll('li').length > 0;
  const stillHasNotes = notesList && notesList.querySelectorAll('li').length > 0;
  if (stillHasProblems || stillHasNotes) return;
  const summary = $ucv2('ucv2ApplyResultSummary');
  summary.classList.add('hidden');
  summary.innerHTML = '';
}

// Shows a new reason on one problem row (2026-10-24). A grouped row shows "name — reason"; when the group had ONE shared line above
// its rows (all rows had the same reason) that line is taken down and every row says its own, so a changed row never contradicts it.
function ucv2SetProblemMessage(li, message) {
  const label = li.dataset.ucv2ProblemLabel;
  const name = li.dataset.ucv2ProblemName;
  const group = li.closest('.ucv2-problem-group');
  if (!group) {
    li.querySelector('.ucv2-problem-text').innerHTML = ucv2ProblemMessageHtml(label, name, message);
    return;
  }
  const body = group.querySelector('[data-ucv2-group-body]');
  // Rows that shared the line above them all had that line's reason (that is why it was shared): each gets it as its own now.
  const shared = body ? body.textContent : '';
  const rows = body ? [...group.querySelectorAll('li')] : [li];
  rows.forEach((row) => {
    const t = row.querySelector('.ucv2-problem-text') || row;
    const rowName = row.dataset.ucv2ProblemName || (t.textContent || '').trim();
    const rowMessage = row === li ? message : shared;
    t.textContent = rowMessage ? `${rowName} — ${rowMessage}` : rowName;
  });
  if (body) body.remove();
}

// Split out from the click listener below (2026-08-23) so the bridge-unavailable modal's own "Try
// Again" can re-fire this SAME retry request for this SAME problem row -- not a generic page reload.
async function ucv2AttemptProblemRetry(btn, li, kind, modId) {
  const endpoint = kind === 'mod' ? '/api/update-collection-v2/apply/retry-mod'
    : kind === 'rules' ? '/api/update-collection-v2/apply/retry-mod-rules'
      : kind === 'attrs' ? '/api/update-collection-v2/apply/retry-collection-attributes'
        : kind === 'updated-membership' ? '/api/update-collection-v2/apply/retry-updated-membership-refresh'
          : '/api/update-collection-v2/apply/retry-membership-cleanup';
  btn.disabled = true;
  btn.textContent = 'Retrying…';
  try {
    const res = await ucv2Api('POST', endpoint, { collectionModId: ucv2ActiveReviewModId, ...(kind === 'mod' ? { modId, fomodPicks: ucv2FomodPicks, ignoreFomodValidationModIds: [...ucv2IgnoreFomodValidationModIds] } : {}) });
    // A mod that needs a FOMOD choice: the picker opens right here (same picker and same picks as the review step), and the
    // retry continues with the choice. Cancel leaves the row as it is.
    if (kind === 'mod' && res.needsFomod) {
      ucv2SetProblemMessage(li, res.error || UCV2_FOMOD_NEEDED_TEXT);
      btn.disabled = false;
      btn.textContent = ucv2RetryButtonLabel(res.error || UCV2_FOMOD_NEEDED_TEXT);
      showFomodPicker(res.fomodChoiceNeeds || [], {
        onIgnoreValidation: (need) => {
          ucv2IgnoreFomodValidationModIds = new Set([...ucv2IgnoreFomodValidationModIds, need.modId]);
          hideFomodPickerModal();
          ucv2AttemptProblemRetry(btn, li, kind, modId);
          return null;
        },
        onDone: (picksByModId) => { ucv2FomodPicks = { ...ucv2FomodPicks, ...picksByModId }; ucv2AttemptProblemRetry(btn, li, kind, modId); },
        onCancel: () => {},
      });
      return;
    }
    // Collection rules' own retry can come back with either a top-level error (couldn't even read
    // Vortex's live mod list) or a per-mod failure inside modsChanged -- either one means this
    // specific problem line is still real.
    const failedRuleMod = kind === 'rules' ? (res.modsChanged || []).find((m) => m.ok === false) : null;
    const succeeded = kind === 'rules' ? (!res.error && !failedRuleMod) : res.ok !== false;
    if (succeeded) {
      // Grouped categories (2026-08-28) -- once this was the LAST remaining problem in its own
      // group, remove the group's heading + now-empty <ul> too, not just the <li> itself. A no-op
      // for the ungrouped collection-level entries (Collection rules/record/membership), which were
      // never wrapped in a .ucv2-problem-group to begin with -- closest() simply finds nothing.
      const group = li.closest('.ucv2-problem-group');
      li.remove();
      if (group && group.querySelectorAll('li').length === 0) group.remove();
      ucv2MaybeClearApplyProblemsBadge();
      return;
    }
    const freshMessage = kind === 'rules' ? (res.error || failedRuleMod?.error || 'Rule apply failed.') : (res.error || 'This is still failing.');
    ucv2SetProblemMessage(li, freshMessage);
    btn.disabled = false;
    btn.textContent = ucv2RetryButtonLabel(freshMessage);
  } catch (err) {
    // Case 2 (DESIGN.md's "Bridge-unavailable messaging" section) -- this retry is a step WITHIN the
    // SAME Apply flow that already confirmed the Vortex Bridge at the start (the main Apply endpoint's own
    // ucv2HandleError already uses this exact modal for this exact error class; this retry button is
    // its sibling within the same flow, not a fresh action starting cold). Reset the button first so
    // the underlying row looks settled while the modal is up, same as ucv2ConfirmApply's own reset
    // before calling ucv2HandleError.
    // Server-unreachable (2026-08-28, director-caught live: a real "Couldn't do that / Failed to
    // fetch" surfaced verbatim during this same testing session, from a server restart landing
    // mid-request) -- a fetch() that can't even connect throws a plain TypeError with no .status at
    // all, so every 409-keyed branch below misses it and it fell through to the generic
    // "err.message || 'The retry failed.'" -- literally the raw browser string. Every other caller in
    // this app already routes this exact error class through isServerUnreachableError/
    // showServerUnreachableError (see ucv2HandleError above); this retry path is its sibling and
    // needed the same check.
    if (window.isServerUnreachableError && window.isServerUnreachableError(err)) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      window.showServerUnreachableError(() => ucv2AttemptProblemRetry(btn, li, kind, modId));
      return;
    }
    if (err.status === 409 && err.body?.error === 'bridge-unavailable') {
      btn.disabled = false;
      btn.textContent = 'Retry';
      window.showBridgeUnavailableModal(() => ucv2AttemptProblemRetry(btn, li, kind, modId));
      return;
    }
    if (err.status === 409 && err.body?.error === 'retry-data-expired') {
      ucv2ShowCriticalError(err.body.message || "This apply's own data has expired -- run Apply Update again to retry.");
    } else if (err.status === 409 && err.body?.error === 'vortex-running') {
      ucv2ShowCriticalError(err.body.message || 'Vortex must be reachable to retry this.');
    } else if (err.status === 409 && err.body?.error === 'apply-in-progress') {
      ucv2ShowCriticalError('An apply is already in progress. Wait for it to finish, then retry.');
    } else {
      ucv2ShowCriticalError(err.message || 'The retry failed.');
    }
    btn.disabled = false;
    btn.textContent = 'Retry';
  }
}

// Delegated on the summary itself -- the problems list is rebuilt wholesale every time
// ucv2RenderApplyResult runs, so a per-button listener would need re-attaching every time; one
// listener here covers every retry button, present or future.
$ucv2('ucv2ApplyResultSummary').addEventListener('click', (e) => {
  const btn = e.target.closest('.ucv2-problem-retry');
  if (!btn) return;
  const li = btn.closest('li');
  const kind = btn.dataset.ucv2RetryKind;
  const modId = btn.dataset.ucv2RetryModid;
  ucv2AttemptProblemRetry(btn, li, kind, modId);
});

// "Continue Update" on the result screen: the same thing the Pick-a-collection screen's own Continue
// button does. The local collection record is only replaced once an apply finishes clean, so a fresh
// review of this collection finds exactly what is still left to do.
function ucv2ContinueUpdate() {
  const modId = ucv2ActiveReviewModId;
  if (!modId) return;
  ucv2CancelReview();
  if (ucv2ActiveReviewModId === null) ucv2StartReview(modId);
}

// Continue Update's first step (2026-10-23): the server saves, by itself, any dependency warning the apply could
// not save, and finishes the update when that was all that was left. Then:
//  - finished -> the card is drawn again with those warnings saved (nothing left to show);
//  - some still not saved -> the card is drawn again with only those, saying Continue Update will try again;
//  - something else is unfinished (or there is no saved data any more) -> the normal review runs as before.
async function ucv2ContinueUpdateClick() {
  const result = ucv2LastApplyResult;
  const modId = ucv2ActiveReviewModId;
  const btn = $ucv2('ucv2ContinueUpdateBtn');
  const hasPendingDeps = !!result && (result.dependencyBreakResults || []).some((r) => r.ok === false);
  if (!hasPendingDeps || !modId) { ucv2ContinueUpdate(); return; }
  if (btn) { btn.disabled = true; btn.textContent = UCV2_CONTINUE_UPDATE_BUSY_LABEL; }
  let outcome = null;
  try {
    outcome = await ucv2Api('POST', '/api/update-collection-v2/apply/finish-pending-rules', { collectionModId: modId });
  } catch { /* fall through to the normal review below */ }
  if (!outcome || outcome.reason === 'no-cached-data') { ucv2ContinueUpdate(); return; }
  const stillPending = new Set(outcome.pendingNames || []);
  (result.dependencyBreakResults || []).forEach((r) => {
    if (r.ok === false && !stillPending.has(r.name)) { r.ok = true; r.error = undefined; r.code = undefined; }
  });
  if (outcome.finalized) {
    result.coreApplyClean = true;
    result.collectionJsonUpdated = true;
    ucv2RenderApplyResultChecked(result, ucv2LastApplyWasOptional);
    return;
  }
  if (stillPending.size > 0) { ucv2RenderApplyResultChecked(result, ucv2LastApplyWasOptional); return; }
  ucv2ContinueUpdate();
}
$ucv2('ucv2ApplyResultSummary').addEventListener('click', (e) => {
  if (e.target.closest('#ucv2ContinueUpdateBtn')) ucv2ContinueUpdateClick();
});

// ucv2ThemedCycleMessage moved to deploy-panel.js as themedCycleMessage (2026-09-14, "the same
// Deploy step on every Done screen") -- the logic was already tool-agnostic (used here for the
// retry-pass guard's own 'cycle-detected' code, right below, AND by ucv2DeployAll's own
// deploy-blocked-by-cycles handling), just namespaced to this one file. deploy-panel.js loads before
// this file in index.html.

// isOptionalPass (2026-08-28) -- true only when this 'done' came from the /apply-optional route
// (frame.optional, set by ucv2HandleApplyEvent). Controls ONLY the Optional Mods Gate block at the
// bottom (ucv2RenderOptionalGateBlock below) -- every other section of this screen (success banner,
// stat cards, problems+retry) renders identically either way, since `result` has the exact same
// shape regardless of which apply pass produced it.
// Result-screen words (2026-10-23). One place so the sentence and its button cannot drift apart.
const UCV2_CONTINUE_UPDATE_NOTE = "This update didn't finish completely. Fix the issues listed above, then click <strong>Continue Update</strong> to finish applying your changes.";
// Used instead of the note above when every problem is a dependency warning still waiting to be saved: the
// person has nothing to fix, Continue Update saves them itself.
const UCV2_CONTINUE_UPDATE_AUTO_NOTE = "Nothing here needs fixing by hand. Click <strong>Continue Update</strong> and it will try again.";
const UCV2_CONTINUE_UPDATE_BUSY_LABEL = 'Trying again…';
let ucv2LastApplyResult = null;
let ucv2LastApplyWasOptional = false;
const UCV2_VORTEX_QUIET_LINE ='Vortex stopped answering for a while during this update.';
// One line, only when a removal did not finish (a success gets no note).
function ucv2RemovalsLine(n) { return n > 0 ? `${n} removal${n === 1 ? '' : 's'} did not finish.` : ''; }
const UCV2_DEPLOY_TITLE_DONE = '🚀 Update complete — one step left';
const UCV2_DEPLOY_BODY_DONE = "Your mods are extracted and registered with Vortex, but your game can't see them yet. Deploy your mods to finish.";
const UCV2_DEPLOY_TITLE_PARTIAL = '🚀 Deploy what was applied';
const UCV2_DEPLOY_BODY_PARTIAL = "The mods that were applied are registered with Vortex, but your game can't see them yet. Deploy them now; the problems above still need your attention.";
const UCV2_DEPLOYED_PARTIAL_TITLE = 'Deployed what was applied';
const UCV2_DEPLOYED_PARTIAL_BODY = 'The problems listed above still need your attention.';
let ucv2ApplyResultHasProblems = false;

// The result card only lists problems that are still true (2026-10-24). Before it is drawn, each failed Update / Add mod, each mod
// that could not be set back to Disabled and each failed collection rule is checked against Vortex as it is now (one read, read
// only). Fixed ones are marked done; if Vortex does not answer the line says it could not check instead of asserting.
const UCV2_COULDNT_CHECK_TEXT = "Couldn't check whether this is still a problem -- Vortex didn't answer.";
async function ucv2RecheckResult(result, collectionModId) {
  if (!result || !collectionModId) return result;
  const items = []; const byId = new Map();
  const add = (kind, entry, extra) => { const id = String(items.length); items.push({ id, kind, ...extra }); byId.set(id, entry); };
  (result.updatedResults || []).filter((x) => x.ok === false && x.newSource).forEach((x) => add('mod', x, { source: x.newSource }));
  (result.addedResults || []).filter((x) => x.ok === false && x.newSource).forEach((x) => add('mod', x, { source: x.newSource }));
  (result.disabledResults || []).filter((x) => x.ok === false && x.vortexModId).forEach((x) => add('disabled', x, { vortexModId: x.vortexModId }));
  ((result.modRulesResult && result.modRulesResult.modsChanged) || []).filter((x) => x.ok === false && x.vortexModId)
    .forEach((x) => add('rules', x, { vortexModId: x.vortexModId }));
  if (items.length === 0) return result;
  let answer = null;
  try { answer = await ucv2Api('POST', '/api/update-collection-v2/apply/recheck-problems', { collectionModId, items }); } catch { answer = null; }
  for (const [id, entry] of byId) {
    if (answer && answer.checked) {
      if (answer.results[id] === 'resolved') { entry.ok = true; entry.error = undefined; entry.code = undefined; entry.recheckedOk = true; }
    } else {
      entry.error = UCV2_COULDNT_CHECK_TEXT;
    }
  }
  return result;
}
async function ucv2RenderApplyResultChecked(result, isOptionalPass) {
  await ucv2RecheckResult(result, ucv2ActiveReviewModId);
  ucv2RenderApplyResult(result, isOptionalPass);
}

function ucv2RenderApplyResult(result, isOptionalPass) {
  ucv2LastApplyResult = result;
  ucv2LastApplyWasOptional = !!isOptionalPass;
  const review = ucv2CurrentReview;
  // After the apply, Vortex shows the name written into it (the collection's Nexus name when it changed).
  if (review && result && result.collectionName) review.collectionName = result.collectionName;
  $ucv2('ucv2ApplyResultTitle').textContent = review ? `${review.collectionName} — ${ucv2RevisionLabel()}` : 'Update applied';
  ucv2SetScreenHeadThumb('ucv2ApplyResultThumb', review?.pictureUrl);
  ucv2GoScreen('ucv2ScreenApplyResult');
  // Reset the success banner + deploy-result box back to their fresh-apply defaults -- a prior
  // apply pass on this same screen (e.g. the main apply, then an optional-mods pass) may have
  // already rewritten the banner to "Deploy complete" via ucv2ShowDeployComplete, or left an error
  // in ucv2DeployResult -- this new result needs its own "just applied, not yet deployed" state.
  $ucv2('ucv2ApplyResultSuccessBanner').innerHTML = '<div class="callout__title">🎉 Collection Updated Successfully!</div>'
    + '<div class="callout__body">After you deploy, please verify in Vortex that all mods and plugins are enabled, make any final adjustments, and enjoy your update!</div>';
  $ucv2('ucv2DeployResult').classList.add('hidden');
  $ucv2('ucv2ApplyResultSuccessBanner').classList.remove('hidden');
  // The Optional Mods Gate itself only appears once Deploy genuinely succeeds (2026-08-28,
  // director's own catch -- it was showing right alongside the "Deploy your mods to finish"
  // banner, before the update was even visible to the game). Remembered here so
  // ucv2ShowDeployComplete -- which has no isOptionalPass of its own -- can render it at the right
  // moment instead; explicitly hidden now so a fresh apply result never shows a STALE gate left
  // over from a previous deploy on this same screen.
  ucv2ApplyResultIsOptionalPass = !!isOptionalPass;
  $ucv2('ucv2OptionalInfo').style.display = 'none';
  $ucv2('ucv2OptionalDecisionRow').style.display = 'none';
  const allUpdatedOk = result.updatedResults.every((r) => r.ok !== false);
  const allRemovedOk = result.removedResults.every((r) => r.ok !== false);
  const allAddedOk = (result.addedResults || []).every((r) => r.ok !== false);
  const allDisabledOk = (result.disabledResults || []).every((r) => r.ok !== false);
  const allRulesOk = !result.modRulesResult || (!result.modRulesResult.error && (result.modRulesResult.modsChanged || []).every((m) => m.ok !== false));
  const allDependencyBreaksOk = (result.dependencyBreakResults || []).every((r) => r.ok !== false);
  const allArchiveDeletesOk = (result.deletedArchiveResults || []).every((r) => r.ok !== false);
  const allCollectionAttributesOk = result.collectionAttributesUpdated !== false;
  const allRemovedMembershipOk = !result.removedMembershipCleanup || result.removedMembershipCleanup.ok !== false;
  const allUpdatedMembershipOk = !result.updatedMembershipRefresh || result.updatedMembershipRefresh.ok !== false;
  const allOk = allUpdatedOk && allRemovedOk && allAddedOk && allDisabledOk && allRulesOk && allDependencyBreaksOk
    && allArchiveDeletesOk && allCollectionAttributesOk && allRemovedMembershipOk && allUpdatedMembershipOk;

  // Named up front (2026-08-21) -- "Applied with some problems" used to make you scan every section
  // below for a stray ✗ to find out what actually went wrong. Every real failure across every
  // category, named right in the summary, so a 100-mod apply doesn't hide its one real problem.
  // The plain-language message lives server-side now (lib/update-collection-v2-runner.js's own
  // describeApplyFailure/APPLY_FAILURE_MESSAGES, 2026-08-22) -- that's the SAME text the live per-mod
  // pill's own tooltip already shows during Apply, so x.error is already a real, accurate sentence by
  // the time it gets here. This used to keep a SECOND, separately-worded copy of the same explanations
  // here on the frontend, which meant the live tooltip and this final summary could show two different
  // sentences for the identical failure -- consolidated back to one source of truth.
  // Each problem is {label, name, message, retry} -- retry (2026-08-23) is only ever set for the
  // four categories this task built a real, standalone re-run operation for: a single mod's own
  // extraction (keyed by its real modId), this revision's own collection rules, the collection's own
  // record (revisionNumber/version), and its own removed-mod membership cleanup. Every other
  // category (Remove/Keep disabled/Dependency warning/Delete archive) has no real retry mechanism
  // built yet, so those never get a button that would silently do nothing.
  const problems = [];
  // code (2026-09-04): the archive-locator-level error code (HASH_MISMATCH being the one this app
  // currently acts on) threaded through from rebuildSingleMod -> describeApplyFailure's own caller
  // in the runner, all the way to this per-mod result -- see ucv2GroupProblems' own cross-cutting
  // hash-mismatch group, which pulls these out of the normal Update/Add grouping by this field,
  // regardless of which operation they came from.
  const pushProblem = (label, name, message, retry, code) => problems.push({ label, name, message, retry: retry || null, code: code || null });
  // A cycle-blocked retry (2026-08-30, real live incident -- runApply's own retryStillFailedRemovals/
  // retryStillFailedDependencyAcknowledgements) is the one server-side message that DOES need a
  // frontend-side swap -- the server has no access to the browser's active theme, so it sends the
  // director's own plain fallback wording with a distinct code instead. Same "ThemedName (Cycle
  // Vortex Bridge)" cross-tool reference convention this app already uses elsewhere (app.js's own
  // VIEW_SUFFIXES comment, window.themedToolName) -- only shown when the theme's own name for
  // 'cycle-helper' actually differs from the plain "Cycle Helper" fallback (the plain theme's own
  // entry IS "Cycle Helper", so this never renders the redundant "Cycle Helper (Cycle Helper)").
  const resolveProblemMessage = (x) => themedCycleMessage(x.error, x.code, 'cycle-detected');
  (result.updatedResults || []).filter((x) => x.ok === false)
    .forEach((x) => pushProblem('Update', x.name, x.error, x.modId ? { kind: 'mod', modId: x.modId } : null, x.code));
  (result.removedResults || []).filter((x) => x.ok === false)
    .forEach((x) => pushProblem('Remove', x.name, resolveProblemMessage(x)));
  (result.addedResults || []).filter((x) => x.ok === false)
    .forEach((x) => pushProblem('Add', x.name, x.error, x.modId ? { kind: 'mod', modId: x.modId } : null, x.code));
  (result.disabledResults || []).filter((x) => x.ok === false)
    .forEach((x) => pushProblem('Keep disabled', x.name, x.error));
  (result.dependencyBreakResults || []).filter((x) => x.ok === false)
    .forEach((x) => pushProblem('Dependency warning', x.name, resolveProblemMessage(x)));
  (result.deletedArchiveResults || []).filter((x) => x.ok === false)
    .forEach((x) => pushProblem('Delete archive', x.name, x.error));
  if (result.modRulesResult?.error) {
    pushProblem('Collection rules', null, result.modRulesResult.error, { kind: 'rules' });
  }
  (result.modRulesResult?.modsChanged || []).filter((m) => m.ok === false)
    .forEach((m) => pushProblem('Collection rules', m.name, m.error || 'Rule apply failed.', { kind: 'rules' }));
  if (result.collectionAttributesUpdated === false) {
    pushProblem('Collection record', null, result.collectionAttributesError || "Couldn't update Vortex's own record for this collection.", { kind: 'attrs' });
  }
  if (result.removedMembershipCleanup && result.removedMembershipCleanup.ok === false) {
    pushProblem('Collection membership', null, result.removedMembershipCleanup.error || "Couldn't update the collection's own membership list.", { kind: 'membership' });
  }
  if (result.updatedMembershipRefresh && result.updatedMembershipRefresh.ok === false) {
    pushProblem('Collection membership', null, result.updatedMembershipRefresh.error || "Couldn't refresh the collection's own membership list for an updated mod -- it may still show as needing install in Vortex.", { kind: 'updated-membership' });
  }

  // Deliberately NOT duplicating "Could not update Vortex's own record" here -- the Collection
  // record problem entry above already carries that same message, now with a real Retry button;
  // repeating it as a second, non-retryable note read as two separate complaints about one failure.
  //
  // Two different reasons collectionJsonUpdated can be false, worded differently (2026-09-01,
  // director's own catch: "how can we have an error writing to our own file?" -- a fair question,
  // since the old single message implied a file error even for the common case). coreApplyClean
  // false means this update genuinely didn't finish -- the local record was correctly never touched
  // (not an error at all, see runApply's own "Replace local collection.json" comment); coreApplyClean
  // true but collectionJsonUpdated still false means the write itself genuinely failed.
  // summaryIsPartial (2026-09-01, director's own explicit correction, live-caught): "we don't use
  // the green check any more, Applied means we did something, like fixed something" -- a green
  // "✅ Applied" title with a "this update didn't finish completely" note directly underneath it
  // was a real, confusing contradiction. Either summaryNotes case means the update is NOT actually
  // done, regardless of allOk (allOk only tracks per-mod problems, not this collection-level gap) --
  // both get the same warning treatment now, never the green/neutral one.
  // Non-blocking "it still worked, but" heads-up (2026-08-31, director's own explicit request) --
  // deliberately separate from summaryNotes/problems above: a mod with a skipped file genuinely
  // installed successfully (ok:true), so it must never flip the banner to the yellow "some problems"
  // styling or claim the update didn't finish. Collected across both Added and Updated mods since
  // both share the same extraction engine (rebuildSingleMod) and can hit the same 7-Zip quirk.
  const extractionNotes = [];
  [...(result.addedResults || []), ...(result.updatedResults || [])].forEach((x) => {
    if (Array.isArray(x.skippedFiles) && x.skippedFiles.length > 0) {
      const fileWord = x.skippedFiles.length === 1 ? 'file' : 'files';
      extractionNotes.push(`<strong>${escHtmlUcv2(x.name)}</strong> -- ${x.skippedFiles.length} ${fileWord} inside this mod's package couldn't be extracted (everything else installed fine). You may want to let the mod author know.`);
    }
    if (x.autoResolvedDuplicate) {
      extractionNotes.push(`<strong>${escHtmlUcv2(x.name)}</strong> -- your downloads folder had more than one matching file for this mod; one was picked automatically. Delete the extras if you don't need them.`);
    }
  });

  const summaryNotes = [];
  let summaryIsPartial = false;
  let continueUpdateButton = false;
  if (!result.collectionJsonUpdated && result.coreApplyClean === false) {
    summaryIsPartial = true;
    const onlyPendingDependencyWarnings = problems.length > 0 && problems.every((p) => p.label === 'Dependency warning');
    summaryNotes.push(onlyPendingDependencyWarnings ? UCV2_CONTINUE_UPDATE_AUTO_NOTE : UCV2_CONTINUE_UPDATE_NOTE);
    continueUpdateButton = true;
  } else if (!result.collectionJsonUpdated) {
    summaryIsPartial = true;
    summaryNotes.push('Could not save the update record due to a file error -- the next Check for Updates may show this same diff again.');
  }
  const summary = $ucv2('ucv2ApplyResultSummary');
  const removalsLine = ucv2RemovalsLine((result.removedResults || []).filter((x) => x.ok === false).length);
  // One headline (2026-10-23): when the amber block has anything to say it IS the headline, so the
  // green "Updated Successfully" banner is not shown next to it. Remembered for the Deploy step's own words.
  ucv2ApplyResultHasProblems = !(allOk && problems.length === 0 && summaryNotes.length === 0);
  $ucv2('ucv2ApplyResultSuccessBanner').classList.toggle('hidden', ucv2ApplyResultHasProblems);
  $ucv2('ucv2DeployPendingTitle').textContent = ucv2ApplyResultHasProblems ? UCV2_DEPLOY_TITLE_PARTIAL : UCV2_DEPLOY_TITLE_DONE;
  $ucv2('ucv2DeployPendingBody').textContent = ucv2ApplyResultHasProblems ? UCV2_DEPLOY_BODY_PARTIAL : UCV2_DEPLOY_BODY_DONE;
  // Hidden entirely on a genuinely clean apply (2026-08-28, director's own catch: "remove that
  // Applied banner - not sure why it's there") -- with nothing to actually say (no problems, no
  // notes), this was just a redundant "✅ Applied" box duplicating the top success banner's own
  // celebratory role. Still shown, same as before, whenever there's real content underneath it.
  if (allOk && problems.length === 0 && summaryNotes.length === 0) {
    summary.classList.add('hidden');
    summary.innerHTML = '';
  } else {
    summary.classList.remove('hidden');
    const isWarning = !allOk || summaryIsPartial;
    summary.className = `callout${isWarning ? ' callout--warning' : ''}`;
    const title = !allOk ? '⚠️ Applied with some problems' : (summaryIsPartial ? '⚠️ Partially Applied' : '🎉 Applied');
    // Grouped (2026-08-28) -- see ucv2ProblemsHtml's own header comment. #ucv2ApplyProblemsList is
    // now a plain wrapper div (was a flat <ul>) so it can hold one heading+<ul> pair per grouped
    // category plus the ungrouped collection-level entries' own <ul> -- ucv2MaybeClearApplyProblemsBadge's
    // own querySelectorAll('li') still works unchanged (it searches every descendant, any nesting depth).
    summary.innerHTML = `<div class="callout__title">${title}</div>`
      // Said once, only when the run really saw Vortex stop answering (result.vortexWentQuiet)
      + (problems.length > 0 && result.vortexWentQuiet ? `<p style="margin:6px 0 0">${UCV2_VORTEX_QUIET_LINE}</p>` : '')
      + (removalsLine ? `<p style="margin:6px 0 0">${removalsLine}</p>` : '')
      + (problems.length > 0 ? `<div id="ucv2ApplyProblemsList">${ucv2ProblemsHtml(problems)}</div>` : '')
      + (summaryNotes.length > 0 ? `<ul id="ucv2ApplyResultSummaryNotes" style="margin:0;padding-left:20px">${summaryNotes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '')
      // The sentence above names this button, so the button exists exactly when the sentence does
      + (continueUpdateButton ? '<div class="row-actions" style="margin-top:10px"><button type="button" class="btn btn--primary btn--small" id="ucv2ContinueUpdateBtn">Continue Update</button></div>' : '');
  }

  const parts = [];
  // No more automatic deploy here (2026-08-27, director's own architecture call) -- this apply only
  // ever extracted/registered/ruled mods; it never touches Data/ or creates hardlinks/symlinks
  // itself. See ucv2DeployAll below for the real, explicit "Deploy" step this screen now offers
  // instead (shown/hidden right after this function returns, via ucv2UpdateDeployBanner).
  // "You curated this collection" (2026-08-18) -- purely informational, so it's casual register and
  // sits above the per-section detail lists, not gating or blocking anything. No in-app Edit
  // button/deep-link -- this project can't replicate Vortex's own Workshop collection editor, so it
  // just points there. Top margin only (2026-08-29, director-caught spacing gap) -- bottom margin
  // deliberately left to the shared .callout default (20px) instead of the old tight 6px override, so
  // the gap before whatever comes next (Deploy Pending, or nothing) matches the gap above this banner
  // instead of sitting visibly tighter than it.
  if (result.isOwnCollection) {
    parts.push('<div class="callout callout--info" style="margin-top:14px">'
      + '<div class="callout__title">🎨 You curated this collection!</div>'
      + 'Want to tweak anything -- swap a mod, change a rule? Head over to the <strong>Workshop</strong> tab in Vortex to edit it there.'
      + '</div>');
  }
  if (extractionNotes.length > 0) {
    parts.push('<div class="callout callout--info" style="margin-top:14px">'
      + '<div class="callout__title">📄 Heads up: one of the files in a package couldn\'t be extracted</div>'
      + `<ul style="margin:0;padding-left:20px">${extractionNotes.map((n) => `<li>${n}</li>`).join('')}</ul>`
      + '</div>');
  }
  // Compact numeric summary (2026-08-27, director's own call, replacing a per-mod wall of text on a
  // real apply touching dozens of mods) -- same stat-card shape Rebuild Missing Files already uses
  // (merge-stat-grid/merge-stat/merge-stat__n/merge-stat__l, reused as-is, no new pattern). Never a
  // second place a failure gets reported -- every real failure already has its own full line (name +
  // message + Retry where applicable) in the top problems callout above, so every count here is
  // filtered to ok !== false first, same "a success heading only ever means it actually worked"
  // reasoning the old per-section lists already followed. One card per category that actually has
  // something in it -- skip a card entirely when its count is 0, same guard the old lists used on
  // their own filtered length.
  const statCards = [];
  const pushStat = (n, label) => { if (n > 0) statCards.push({ n, label }); };
  pushStat((result.updatedResults || []).filter((x) => x.ok !== false).length, 'Updated');
  pushStat((result.removedResults || []).filter((x) => x.ok !== false).length, 'Removed');
  pushStat((result.disabledResults || []).filter((x) => x.ok !== false).length, 'Kept disabled');
  pushStat((result.dependencyBreakResults || []).filter((x) => x.ok !== false).length, 'Dependency warnings acknowledged');
  pushStat((result.deletedArchiveResults || []).filter((x) => x.ok !== false).length, 'Archives deleted');
  pushStat((result.addedResults || []).filter((x) => x.ok !== false).length, 'Added');
  // Rules-written COUNT only -- a collection-rules failure already has its own full line (with
  // Retry) in the problems callout above (pushProblem('Collection rules', ...)); showing it again
  // here too was real duplication the old per-section list had. This card is a plain success count,
  // same as every other one, gated the same way (0 = no card).
  pushStat((result.modRulesResult && result.modRulesResult.totalRulesWritten) || 0, 'Rules set');
  // Own dedicated container, above the success banner (2026-08-28, director's own placement call) --
  // see index.html's own comment on #ucv2ApplyResultStats for why this is split out of `parts`
  // rather than living inside ucv2ApplyResultList like the rest of this screen's content. Always set
  // (never conditionally left stale) so a second apply pass on this same screen with fewer/no stats
  // doesn't leave the previous pass's own cards showing.
  $ucv2('ucv2ApplyResultStats').innerHTML = statCards.map((s) => `<div class="merge-stat"><div class="merge-stat__n">${s.n}</div><div class="merge-stat__l">${escHtmlUcv2(s.label)}</div></div>`).join('');
  $ucv2('ucv2ApplyResultList').innerHTML = parts.join('');
  ucv2UpdateDeployBanner();
  window.scrollTo(0, 0);
}

// ---- Optional Mods Gate / Optional Installs (2026-08-28, director's own build-out, matching real
// Vortex's own "Collection installation complete" dialog -- design/vortex-update-collection-v2-
// mockup.html's own #screenOptionalGate/#screen4 are the word-of-truth spec). Shown right under the
// existing Apply Result content -- only after the MAIN apply's own completion, and only when this
// collection genuinely has optional mods available. ----

// review.optionalMods (2026-08-28) -- real, live-filtered mods with optional===true that aren't
// already installed (see reviewUpdate's own header comment on that field for the exact filtering).
// Never shown at all once this becomes an optional-mods apply pass's OWN completion (isOptionalPass)
// -- that choice is already made, nothing left to decide.
function ucv2RenderOptionalGateBlock(isOptionalPass) {
  const optionalMods = ucv2CurrentReview?.optionalMods || [];
  const infoEl = $ucv2('ucv2OptionalInfo');
  const rowEl = $ucv2('ucv2OptionalDecisionRow');
  const show = !isOptionalPass && optionalMods.length > 0;
  infoEl.style.display = show ? '' : 'none';
  rowEl.style.display = show ? 'flex' : 'none';
  if (!show) return;
  const n = optionalMods.length;
  $ucv2('ucv2OptionalInfoTitle').textContent = `${n} optional mod${n === 1 ? '' : 's'} available`;
  $ucv2('ucv2OptionalInfoBody').textContent = `This collection has ${n} optional mod${n === 1 ? '' : 's'} which ${n === 1 ? 'is' : 'are'} not required to complete the installation but may provide additional features or options. You can view these mods before installing as they may change the default behavior of the collection or have additional requirements.`;
}

// Real error path, shown while on ucv2ScreenApplyResult/ucv2ScreenOptionalInstalls -- ucv2ShowCriticalError
// itself is screen-agnostic (its own element lives above every screen div, not inside any one of
// them -- see index.html's own comment on that), so this works correctly regardless of which of the
// two screens the director was on when the apply-optional POST failed.
async function ucv2StartOptionalApply(mods) {
  if (!mods || mods.length === 0) return;
  ucv2OptionalFlowActive = true; // covers "Install all", which skips the picker screen entirely
  ucv2LastOptionalApplyMods = mods;
  ucv2HideCriticalError();
  const r = ucv2CurrentReview;
  try {
    // 202 with an empty body as soon as basic validation + the single-apply-at-a-time guard clear
    // (2026-08-31, same fix ucv2ConfirmApply's own comment already explains for the main flow --
    // ported here, diagnostics/2026-08-30-real-apply-marathon-findings.md finding #5).
    // prepareApplyOptional's own gates (BRIDGE_UNAVAILABLE/FOMOD_CHOICES_NEEDED) used to be checked
    // synchronously BEFORE this ever returned, which is exactly why a real 3-optional-mod submit sat
    // on a bare "Applying..." for 6+ minutes with zero indication anything was happening. They now
    // run AFTER the stream starts, arriving as error frames via GET /apply/events instead --
    // ucv2HandleApplyEvent's own 'error' branch, gated on frame.optional, handles them.
    await ucv2Api('POST', '/api/update-collection-v2/apply-optional', {
      collectionModId: ucv2ActiveReviewModId,
      optionalModKeys: mods.map(ucv2OptionalModId),
      targetRevisionNumber: r.newRevisionNumber,
      fomodPicks: ucv2FomodPicks,
      ignoreFomodValidationModIds: [...ucv2IgnoreFomodValidationModIds],
    });
  } catch (e) {
    ucv2HandleError(e, () => ucv2StartOptionalApply(mods));
    return;
  }
  ucv2RenderApplyProgressScreen(ucv2BuildOptionalApplyRows(mods), `Applying optional updates to ${r.collectionName} — Rev ${r.newRevisionNumber ?? '?'}`, r.pictureUrl);
  if (ucv2ApplyEventSource) ucv2ApplyEventSource.close();
  const es = new EventSource('/api/update-collection-v2/apply/events');
  ucv2ApplyEventSource = es;
  es.onmessage = (msg) => ucv2HandleApplyEvent(JSON.parse(msg.data));
  ucv2StartApplyStallPolling();
}

$ucv2('ucv2OptionalNoThanksBtn').addEventListener('click', ucv2CancelReview);
$ucv2('ucv2OptionalViewBtn').addEventListener('click', () => ucv2RenderOptionalInstallsScreen());
$ucv2('ucv2OptionalInstallAllBtn').addEventListener('click', () => ucv2StartOptionalApply(ucv2CurrentReview?.optionalMods || []));

// ---- Optional Installs picker (2026-08-28) -- reached only via "View optional mods" above. Same
// action-row + legend pattern the Removed screen already established (Select all/Invert/Clear, a
// real count, a one-line legend) -- same shape, different meaning (checked = install, not keep). ----
let ucv2OptionalPickedModIds = new Set();

// modId:fileId, NOT just m.source.modId (2026-08-28, same real collision class as
// ucv2AddedModId/ucv2UpdatedModId above -- see ucv2AddedModId's own header comment). Without this, a
// modId shared by two optional file variants (e.g. HIMBO/CBBE 3BA) would make the "select all"/
// individual-checkbox state collapse onto ONE shared entry, and checking just one variant's box
// would silently install both once submitted (optionalModKeys below is filtered by this SAME
// bare-vs-full key shape).
function ucv2OptionalModId(m) {
  const modId = m.source && m.source.modId;
  const fileId = m.source && m.source.fileId;
  return modId != null && fileId != null ? `${modId}:${fileId}` : String(modId ?? m.name);
}

function ucv2OptionalRowHtml(m) {
  const modId = ucv2OptionalModId(m);
  const instrBtn = m.instructions
    ? `<button class="ucv2-instr-btn" title="Has instructions" data-ucv2-instr-name="${escHtmlUcv2(m.name)}" data-ucv2-instr-body="${escHtmlUcv2(m.instructions)}">ⓘ</button>`
    : '';
  return `<tr><td><input type="checkbox" class="ucv2-optional-check" data-ucv2-optional-modid="${escHtmlUcv2(modId)}" ${ucv2OptionalPickedModIds.has(modId) ? 'checked' : ''}></td>`
    + `<td>${escHtmlUcv2(m.name)}</td><td>${m.version ? escHtmlUcv2(m.version) : ''}</td><td>${escHtmlUcv2(m.author || '')}</td><td>${instrBtn}</td></tr>`;
}

function ucv2UpdateOptionalCount() {
  const total = (ucv2CurrentReview?.optionalMods || []).length;
  const n = ucv2OptionalPickedModIds.size;
  $ucv2('ucv2OptionalSelectedCount').textContent = `${n} of ${total} selected`;
  $ucv2('ucv2OptionalHeaderCheckbox').checked = total > 0 && n === total;
  $ucv2('ucv2OptionalFinishBtn').disabled = n === 0;
}

function ucv2SyncOptionalCheckboxes() {
  document.querySelectorAll('#ucv2OptionalInstallsTableBody input[data-ucv2-optional-modid]').forEach((cb) => {
    cb.checked = ucv2OptionalPickedModIds.has(cb.dataset.ucv2OptionalModid);
  });
  ucv2UpdateOptionalCount();
}

function ucv2RenderOptionalInstallsScreen() {
  ucv2OptionalFlowActive = true;
  const mods = ucv2CurrentReview?.optionalMods || [];
  // Every mod starts checked -- matches the mockup's own real default (2 of 3 pre-checked isn't a
  // real rule, just that mockup's own hand-picked demo state; the honest real default here is "every
  // real optional mod is checked," same "select all by default" convention this screen's own header
  // checkbox and Removed/Update-Collection's other checkbox lists already follow for their own
  // default-safe choice).
  ucv2OptionalPickedModIds = new Set(mods.map(ucv2OptionalModId));
  ucv2SetScreenHeadThumb('ucv2OptionalInstallsThumb', ucv2CurrentReview?.pictureUrl);
  $ucv2('ucv2OptionalInstallsTableBody').innerHTML = mods.map(ucv2OptionalRowHtml).join('');
  ucv2UpdateOptionalCount();
  ucv2GoScreen('ucv2ScreenOptionalInstalls');
}

$ucv2('ucv2OptionalInstallsTableBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-ucv2-optional-modid]');
  if (!cb) return;
  if (cb.checked) ucv2OptionalPickedModIds.add(cb.dataset.ucv2OptionalModid);
  else ucv2OptionalPickedModIds.delete(cb.dataset.ucv2OptionalModid);
  ucv2UpdateOptionalCount();
});
$ucv2('ucv2OptionalInstallsTableBody').addEventListener('click', (e) => {
  const btn = e.target.closest('.ucv2-instr-btn');
  if (btn) ucv2OpenInstructions(btn.dataset.ucv2InstrName, btn.dataset.ucv2InstrBody);
});
$ucv2('ucv2OptionalHeaderCheckbox').addEventListener('change', (e) => {
  ucv2OptionalPickedModIds = e.target.checked ? new Set((ucv2CurrentReview?.optionalMods || []).map(ucv2OptionalModId)) : new Set();
  ucv2SyncOptionalCheckboxes();
});
$ucv2('ucv2OptionalSelectAllBtn').addEventListener('click', () => {
  ucv2OptionalPickedModIds = new Set((ucv2CurrentReview?.optionalMods || []).map(ucv2OptionalModId));
  ucv2SyncOptionalCheckboxes();
});
$ucv2('ucv2OptionalInvertBtn').addEventListener('click', () => {
  (ucv2CurrentReview?.optionalMods || []).forEach((m) => {
    const id = ucv2OptionalModId(m);
    if (ucv2OptionalPickedModIds.has(id)) ucv2OptionalPickedModIds.delete(id); else ucv2OptionalPickedModIds.add(id);
  });
  ucv2SyncOptionalCheckboxes();
});
$ucv2('ucv2OptionalClearBtn').addEventListener('click', () => {
  ucv2OptionalPickedModIds.clear();
  ucv2SyncOptionalCheckboxes();
});
$ucv2('ucv2OptionalFinishBtn').addEventListener('click', () => {
  const picked = (ucv2CurrentReview?.optionalMods || []).filter((m) => ucv2OptionalPickedModIds.has(ucv2OptionalModId(m)));
  ucv2StartOptionalApply(picked);
});

// ---- Explicit "Deploy" step (2026-08-27, director's own architecture call) ----
// This apply only ever extracts/registers/rules mods -- it never touches Data/ or creates
// hardlinks/symlinks itself, that's exclusively Vortex's own job. Same real fire-and-poll shape
// Missing Masters' own mmDeployAll (web/public/missing-masters-app.js) already establishes for the
// identical problem -- not a new pattern, mirrored directly rather than inventing a second one.
let ucv2DeployInFlight = false;
// Set by ucv2RenderApplyResult, read by ucv2ShowDeployComplete -- see that render function's own
// comment for why the Optional Mods Gate waits for a real deploy success instead of showing here.
let ucv2ApplyResultIsOptionalPass = false;

// Shown once, right after a real apply finishes (every apply now needs a deploy, unlike the old
// conditional-on-plugin-change design) -- hidden again while a deploy is actually running so its own
// progress/result callouts have the space to themselves.
function ucv2UpdateDeployBanner() {
  $ucv2('ucv2DeployPending').classList.toggle('hidden', ucv2DeployInFlight);
  // Disabled for the duration of a real deploy (2026-08-28, director's own catch) -- leaving this
  // screen mid-deploy doesn't stop the real Vortex deploy already running server-side, but it does
  // orphan this screen's own live progress/result reporting for it, and Deploy is real file I/O
  // that shouldn't be walked away from blind.
  $ucv2('ucv2ApplyResultBackBtn').disabled = ucv2DeployInFlight;
}

// Used by ucv2StartApplyStallPolling below (the Apply-progress screen's own separate stall poller --
// unrelated to the Deploy panel's own polling, which now runs entirely through deploy-panel.js's
// shared startDeploy). Just an alias onto that file's own DEPLOY_STALL_THRESHOLD_TICKS so the two
// don't drift -- deploy-panel.js loads before this file in index.html. 15 ticks (the poll runs once
// per second) -- long enough that a normal, briefly-slow response never trips it, short enough that
// the director isn't left wondering for a full minute before getting a nudge to go check Vortex. Now
// only a FALLBACK -- see deploy-panel.js's own deployStallMessage for the real, bridge-reported
// signal that fires immediately instead of waiting this out.
const UCV2_DEPLOY_STALL_THRESHOLD_TICKS = DEPLOY_STALL_THRESHOLD_TICKS;
// Shared by both Deploy's own tick-count fallback and Apply's own SSE-quiet fallback below --
// renamed from the old DEPLOY-only name (2026-08-29) once Apply started using it too.
const UCV2_STALL_HINT_DEFAULT = '⚠️ Vortex is taking longer than usual to apply this update. Please be patient while it finishes.';

// ucv2DeployStallMessage moved to deploy-panel.js as deployStallMessage (2026-09-14, "the same
// Deploy step on every Done screen") -- still used directly below by ucv2StartApplyStallPolling
// (the Apply-progress screen's own separate poll, reading the same shared /api/deploy/all/progress
// purely for its externalChangesPending/blockingDialogs fields).
// Shared DOM update for both screens' own stall-hint element -- Deploy and Apply each keep their own
// thin wrapper below (own element id) rather than callers passing an id around everywhere.
function ucv2UpdateStallHint(elementId, show, message) {
  const el = $ucv2(elementId);
  el.innerHTML = message || UCV2_STALL_HINT_DEFAULT;
  el.classList.toggle('hidden', !show);
}
function ucv2UpdateDeployStallHint(show, message) {
  ucv2UpdateStallHint('ucv2DeployStallHint', show, message);
}
// Same sentence the server sends as the phase text (VORTEX_BUSY_PHASE_TEXT in the runner).
const UCV2_APPLY_BUSY_TEXT = 'Vortex is taking longer than usual to apply this update. Please be patient while it finishes.';

// Apply/Install's own "taking longer than usual" hint (2026-08-29; reworked 2026-10-23). Apply's real progress
// arrives via the /apply/events SSE stream (ucv2HandleApplyEvent below). This timer only watches the stream for
// silence -- it never asks Vortex anything (an apply does not deploy, so there is no deploy progress to read).
let ucv2ApplyPollTimer = null;
let ucv2ApplyPollStopped = true;
let ucv2ApplyLastEventAt = 0;
function ucv2StopApplyStallPolling() {
  ucv2ApplyPollStopped = true;
  if (ucv2ApplyPollTimer) {
    clearTimeout(ucv2ApplyPollTimer);
    ucv2ApplyPollTimer = null;
  }
}
function ucv2StartApplyStallPolling() {
  ucv2ApplyLastEventAt = Date.now();
  ucv2ApplyPollStopped = false;
  // No request to Vortex here at all (2026-10-23, director: "nothing should check deploy unless we are
  // actually deploying"). An apply never starts a deploy, so there is nothing for GET /mods/deploy-all/progress
  // to report, and each extra request landed on a Vortex that could not answer. The hint is judged purely
  // from the page's own clock: no new /apply/events frame for UCV2_DEPLOY_STALL_THRESHOLD_TICKS seconds.
  const tick = () => {
    if (ucv2ApplyPollStopped) return;
    const quietMs = Date.now() - ucv2ApplyLastEventAt;
    // The sentence goes in the activity line itself (one place). If the server already sent it as the
    // phase text, it is already showing and nothing more is drawn.
    if (quietMs >= UCV2_DEPLOY_STALL_THRESHOLD_TICKS * 1000) {
      const phaseEl = $ucv2('ucv2ApplyProgressPhaseText');
      if (phaseEl.textContent !== UCV2_APPLY_BUSY_TEXT) phaseEl.textContent = UCV2_APPLY_BUSY_TEXT;
    }
    ucv2ApplyPollTimer = setTimeout(tick, UCV2_APPLY_POLL_BASE_MS);
  };
  ucv2ApplyPollTimer = setTimeout(tick, UCV2_APPLY_POLL_BASE_MS);
}

// Deploy success (2026-08-28, director's own flow call) -- replaces the top success banner's own
// content in place rather than showing a second, separate "deploy complete" callout further down
// the screen. The "Update complete -- one step left" banner is permanently hidden here too (not
// just toggled off for the duration of the poll via ucv2UpdateDeployBanner) -- once a deploy has
// actually succeeded there's no "one step left" left to prompt for.
function ucv2ShowDeployComplete() {
  if (ucv2ApplyResultHasProblems) {
    // The amber block above is still the headline: no "All Set" next to unresolved problems.
    $ucv2('ucv2DeployPending').classList.add('hidden');
    const box = $ucv2('ucv2DeployResult');
    box.classList.remove('hidden');
    box.className = 'callout callout--success';
    box.innerHTML = `<div class="callout__title">${UCV2_DEPLOYED_PARTIAL_TITLE}</div><div class="callout__body">${UCV2_DEPLOYED_PARTIAL_BODY}</div>`;
    ucv2RenderOptionalGateBlock(ucv2ApplyResultIsOptionalPass);
    return;
  }
  // "After a successful deploy, the Done screen shows one All Set banner" (2026-09-15) -- same
  // wording/title all three tools sharing the Deploy step now use (Rebuild Missing Files,
  // Rebuild Collection, Update Collection); Update Collection only has the one situation (its own
  // Apply already finished by the time Deploy can even run, so there's no "nothing to update"
  // variant the way the other two tools have a "nothing missing/rebuilt" case).
  $ucv2('ucv2ApplyResultSuccessBanner').innerHTML = '<div class="callout__title">🎉 All Set — It\'s Game Time!</div>'
    + '<div class="callout__body">Your collection has been updated and deployed. Your game is ready to launch!</div>';
  $ucv2('ucv2DeployPending').classList.add('hidden');
  // Only now -- not at the top of ucv2RenderApplyResult -- since offering optional mods before the
  // just-applied update is even deployed to the game reads as a step out of order.
  ucv2RenderOptionalGateBlock(ucv2ApplyResultIsOptionalPass);
}

function ucv2ShowDeployResult(kind, message, noRetry) {
  // Real bug, director-caught live via screenshot (2026-09-01): the "Update complete -- one step
  // left" banner (ucv2DeployPending) was only ever hidden on the SUCCESS path
  // (ucv2ShowDeployComplete) -- a failed/cycle-blocked deploy left it showing right alongside this
  // function's own error callout, offering two different-looking "Deploy" buttons for the same
  // next action at once. Once a deploy has actually finished either way, there's no "one step left"
  // prompt left to show -- this function's own result callout (success or Retry Deploy) is now the
  // one and only next action.
  $ucv2('ucv2DeployPending').classList.add('hidden');
  const box = $ucv2('ucv2DeployResult');
  box.classList.remove('hidden');
  box.className = `callout callout--${kind === 'success' ? 'success' : 'warning'}`;
  box.innerHTML = '';
  if (kind === 'success') {
    // Dead in practice (ucv2DeployAll's own onDone calls ucv2ShowDeployComplete() directly on
    // success, never this with kind:'success') -- kept in sync anyway so no stale copy of the old
    // wording lingers next to the live path above.
    box.innerHTML = '<div class="callout__title">🎉 All Set — It\'s Game Time!</div>'
      + '<div class="callout__body">Your collection has been updated and deployed. Your game is ready to launch!</div>';
    return;
  }
  box.innerHTML = `<div class="callout__title">⚠️ Deploy didn't confirm success</div><p>${escHtmlUcv2(message || "Vortex didn't confirm the deploy completed. You can try again from here, or open Vortex and click Deploy Mods directly.")}</p>`;
  // noRetry (2026-09-01, director's own explicit correction, live-caught): a real rule cycle came
  // right back on a Retry Deploy click even though that path never re-touches rules at all --
  // confirming this isn't something a same-tool retry can ever fix. Offering "Retry Deploy" for
  // THIS specific failure just repeats a doomed action; the real fix has to happen in Vortex.
  if (!noRetry) {
    const retry = document.createElement('button');
    retry.className = 'btn btn--primary btn--small';
    retry.textContent = 'Retry Deploy';
    retry.addEventListener('click', () => ucv2DeployAll());
    const row = document.createElement('div');
    row.className = 'row-actions';
    row.appendChild(retry);
    box.appendChild(row);
  }
}

// Real progress, polled from Vortex's own deploy status -- not a fake animation. A deploy on a large
// setup is genuinely slow (minutes), matching this project's own standing rule that a real action
// shows itself happening rather than freezing behind a static label.
async function ucv2DeployAll() {
  ucv2DeployInFlight = true;
  $ucv2('ucv2DeployResult').classList.add('hidden');
  ucv2UpdateDeployBanner(); // hides the "one step left" banner while its own action is running
  $ucv2('ucv2DeployProgress').classList.remove('hidden');
  $ucv2('ucv2DeployPhase').textContent = ucv2GapsFixedForActiveReview
    ? 'Starting…'
    : 'Checking every mod is enabled and part of the collection…';
  $ucv2('ucv2DeployBar').style.width = '0%';

  // Pre-Deploy health check + fix (2026-08-27, director-requested) -- catches a mod that's genuinely
  // installed but silently missing its Enabled flag and/or collection-membership link (the real
  // 2026-08-27 batchDispatch bug's own aftermath) and fixes it automatically, before this same click
  // goes on to deploy. Best-effort: a failure here doesn't block Deploy itself -- whatever it
  // couldn't fix still shows on the Apply Result screen's own per-problem list with its own Retry,
  // and deploying is still the right next step for everything that IS correct.
  //
  // ONE-SHOT ONLY (2026-08-31, director's own call after a live-reproduced bug): this call's own
  // fixCollectionMembershipGaps() unconditionally re-applies the collection's mod rules every time
  // it runs. Vortex itself only ever applies rules during an update/install, never on a plain
  // deploy -- so re-running this on every Retry Deploy was both recreating a rule cycle the director
  // had just manually cleared in Vortex, and (live-confirmed the same session) silently corrupting a
  // mod's file set by re-triggering part of its install. Skip it entirely once it's already run once
  // for this review -- Retry Deploy from here on is a pure deploy, exactly like clicking Deploy Mods
  // directly in Vortex.
  if (ucv2ActiveReviewModId && !ucv2GapsFixedForActiveReview) {
    try {
      const gapsResult = await ucv2Api('POST', '/api/update-collection-v2/fix-collection-gaps', { collectionModId: ucv2ActiveReviewModId });
      // Drop whatever this call just associated out of the STALE review snapshot's own optionalMods
      // (2026-08-30, director-caught real gap: Skyshards Framework/DLCs -- already installed, just
      // needed the membership rule this call writes -- kept showing up in the Optional Mods Gate as
      // "available" even after being associated, since that gate reads ucv2CurrentReview.optionalMods,
      // a snapshot taken back at Review time, never refreshed since). Only ever REMOVES entries this
      // call itself confirmed fixed -- never adds/re-derives, so a genuinely new optional mod that
      // still needs installing is untouched.
      const fixedIds = new Set((gapsResult.fixedMembershipIdentities || []).map((f) => `${f.modId}:${f.fileId}`));
      if (fixedIds.size > 0 && ucv2CurrentReview && Array.isArray(ucv2CurrentReview.optionalMods)) {
        ucv2CurrentReview.optionalMods = ucv2CurrentReview.optionalMods.filter((m) => {
          const key = m.source && m.source.modId && m.source.fileId ? `${m.source.modId}:${m.source.fileId}` : null;
          return !key || !fixedIds.has(key);
        });
      }
    } catch {
      // Best-effort, see comment above -- proceed to deploy regardless.
    } finally {
      // Mark it done regardless of success/failure -- a failed gaps-fix isn't grounds to keep
      // hammering the same rules re-application on every retry either; whatever it couldn't fix
      // still surfaces on the Apply Result screen's own per-problem list with its own Retry path.
      ucv2GapsFixedForActiveReview = true;
    }
  }
  $ucv2('ucv2DeployPhase').textContent = 'Starting…';

  // The actual fire-and-poll loop (percent/text tracking, stall-hint fact-message-or-tick-count,
  // rule-cycle detection) now lives in deploy-panel.js's shared startDeploy (2026-09-14, "the same
  // Deploy step on every Done screen") -- Rebuild Collection's and Rebuild Missing Files' own Deploy
  // panels use the identical engine. Everything below is unchanged behavior, just reached through
  // that engine's callbacks instead of this function's own setInterval.
  await startDeploy('/api/deploy', ucv2Api, {
    onError: (e) => {
      ucv2DeployInFlight = false;
      $ucv2('ucv2DeployProgress').classList.add('hidden');
      ucv2HandleError(e, () => ucv2DeployAll());
      ucv2ShowDeployResult('error', e.message);
      ucv2UpdateDeployBanner();
    },
    onTick: (progress) => {
      if (progress && typeof progress.percent === 'number') {
        $ucv2('ucv2DeployBar').style.width = `${Math.round(progress.percent)}%`;
      }
      if (progress && progress.text) $ucv2('ucv2DeployPhase').textContent = progress.text;
    },
    onStall: (show, message) => ucv2UpdateDeployStallHint(show, message),
    onDone: (progress) => {
      ucv2DeployInFlight = false;
      $ucv2('ucv2DeployProgress').classList.add('hidden');
      // Re-enables the Back button either way (2026-08-28, director's own catch -- the success
      // branch below never called this, so a successful deploy left it disabled forever).
      ucv2UpdateDeployBanner();
      if (progress.error) {
        // deployBlockedByCycles (2026-08-31, diagnostics/2026-08-30-real-apply-marathon-findings.md
        // finding #1) -- the ONE real thing that lands here despite the Vortex Bridge's own deploy call
        // having returned/resolved normally: Vortex can silently abort a deploy because of a rule
        // cycle, so "the call didn't throw" was never actually proof of success. Same theme-
        // substitution every other server-authored cycle message already gets (themedCycleMessage,
        // deploy-panel.js), just gated on this route's own real code instead of the retry-pass
        // guard's.
        ucv2ShowDeployResult('error', themedCycleMessage(progress.error, progress.code, 'deploy-blocked-by-cycles'), progress.code === 'deploy-blocked-by-cycles');
      } else {
        ucv2ShowDeployComplete();
        ucv2QuickVerifyAfterDeploy();
      }
    },
  });
}
// Post-deploy quick reconciliation (2026-09-01, director's own explicit design) -- see
// runner.quickVerifyAndFinalize's own header comment for the full "why". Fires automatically the
// instant Deploy finishes clean, no button click needed -- if this apply's own record was already
// fully clean there's nothing cached to check and this quietly no-ops; if something DID fail
// earlier but is now confirmed genuinely fixed, this finalizes right here so the Pick-a-collection
// screen reads "Up to date" without a separate Continue-update round trip. On any other outcome
// (still broken, Vortex Bridge unreachable, nothing cached) this changes nothing -- the existing
// Continue-update button is still exactly correct as the real fallback, so there's nothing more to
// show the director here either way.
async function ucv2QuickVerifyAfterDeploy() {
  const collectionModId = ucv2CurrentReview && ucv2CurrentReview.collectionModId;
  if (!collectionModId) return;
  try {
    await ucv2Api('POST', '/api/update-collection-v2/verify-and-finalize', { collectionModId });
  } catch {
    // Non-fatal by design -- see this function's own header comment.
  }
}
$ucv2('ucv2DeployBtn').addEventListener('click', () => ucv2DeployAll());

// Jumps to Update Collection (Classic) -- the callout's own inline link at the top of screen1.
const ucv2ClassicLink = $ucv2('ucv2ClassicLink');
if (ucv2ClassicLink) {
  ucv2ClassicLink.addEventListener('click', (e) => { e.preventDefault(); window.navigateToArea('sync'); });
}
