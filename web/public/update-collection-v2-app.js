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
function ucv2VersionLabel(v) {
  return String(v ?? '?');
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

// retryFn is optional -- when given, a Retry button renders in the callout (same btn--ghost btn--small
// pattern the per-line problem-retry buttons already use) that re-runs it and clears the callout.
function ucv2ShowCriticalError(message, retryFn, title) {
  const el = $ucv2('ucv2CriticalError');
  const friendly = ucv2FriendlyErrorMessage(message);
  el.innerHTML = `<div class="callout__title">${escHtmlUcv2(title || "🛑 Couldn't do that")}</div><p>${escHtmlUcv2(friendly)}</p>`
    + (retryFn ? `<button type="button" class="btn btn--ghost btn--small" id="ucv2CriticalErrorRetry">Retry</button>` : '');
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
    // the runner, 2026-08-30) send a distinct message for "Helper didn't answer, Vortex is probably
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
  // The Helper was reachable when this v2 flow started (Update Collection's own upfront check would
  // have routed to Classic otherwise) but died partway through -- Vortex closed, or the extension
  // crashed. Same shared-modal pattern as vortex-running, plus its own "Switch to Classic instead"
  // escape hatch (shell.js's showHelperUnavailableModal).
  if (e.status === 409 && e.body?.error === 'helper-unavailable') {
    window.showHelperUnavailableModal(retryFn || (() => {}));
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
// Helper/Merge Plugins (.merge-stepper/.merge-step, cycle-helper-app.js's CH_STEPS/chRenderStepper)
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
let ucv2PrerequisiteChoices = {}; // addedModKey -> 'install'|'skip' -- resolved missing-prerequisite gate choices, carried across re-apply calls the SAME way ucv2FomodPicks is (2026-08-31 fix: a transitive prerequisite chain re-shows the gate on a later round trip for a NEW mod, and without accumulating here, that later round's POST would only carry the newest round's choices, silently forgetting an earlier round's already-confirmed installs and re-asking about them from scratch)
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
          ? `<button class="btn btn--primary btn--small ucv2-review-btn" data-mod-id="${escHtmlUcv2(c.modId)}" style="width:100%" onclick="ucv2StartReview('${escHtmlUcv2(c.modId)}')">Review update →</button>`
          : c.needsRecheck
            ? `<button class="btn btn--ghost btn--small ucv2-review-btn" data-mod-id="${escHtmlUcv2(c.modId)}" style="width:100%" onclick="ucv2StartReview('${escHtmlUcv2(c.modId)}')">Continue update →</button>`
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
          err.status = (frame.code === 'vortex-running' || frame.code === 'helper-unavailable') ? 409
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
async function ucv2LoadCollections() {
  ucv2HideCriticalError();
  ucv2StopCollectionsPolling();
  try {
    const data = await ucv2Api('GET', '/api/update-collection-v2/collections');
    ucv2Collections = data.collections;
    ucv2RenderCollections();
    if (data.refreshing) {
      ucv2ShowLoading(UCV2_LOADING_TEXT_COLLECTIONS);
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
  ucv2ShowLoading(UCV2_LOADING_TEXT_COLLECTIONS);
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
    ? `Game version ${rev.gameVersions.join(' or ')}` : '';
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
    ucv2CurrentReview = review;
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
  ucv2PrerequisiteChoices = {};
  ucv2UpdateReviewLockUI();
  ucv2HideCriticalError();
  ucv2ShowReviewLoadingSkeleton(modId);
  ucv2ShowReviewActivity(UCV2_LOADING_TEXT_ONE_COLLECTION);
  try {
    const review = await ucv2RunReviewRequest({ collectionModId: modId }, ucv2ShowReviewActivity);
    ucv2CurrentReview = review;
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

function ucv2CancelReview() {
  ucv2ActiveReviewModId = null;
  ucv2CurrentReview = null;
  ucv2OptionalFlowActive = false;
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
function ucv2ResetOnEntry() {
  ucv2KeepInstalledModIds = new Set();
  ucv2KeepRemovedModIds = new Set();
  ucv2DeleteArchives = true;
  $ucv2('ucv2DeleteArchivesCheckbox').checked = true;
  ucv2FomodPicks = {};
  ucv2PrerequisiteChoices = {};
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
  ucv2CheckForUpdates();
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

function ucv2RowHtml(status, pillClass, name, versionText, keepCellHtml, author, instructions, rowClass, modKey, mergedPluginFlag, versionTooltip, isBundled) {
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
  const versionCell = versionTooltip
    ? `<span title="${escHtmlUcv2(versionTooltip)}" style="cursor:help">${escHtmlUcv2(versionText)}</span>`
    : escHtmlUcv2(versionText);
  // data-status (2026-08-28, status filter pills) -- derived from the same `status` label every row
  // already carries (Update/New/Remove/Keep/Installed), lowercased to match the filter badges' own
  // data-status values. Every row gets one, including Keep/Installed (no pill selects those, but the
  // filter still needs to know what to hide when a different pill IS active).
  const statusAttr = ` data-status="${escHtmlUcv2(status.toLowerCase())}"`;
  return `<tr${cls}${keyAttr}${statusAttr}><td><span class="status-pill ${pillClass}">${status}</span></td><td>${escHtmlUcv2(name)}${ucv2BundledFlagHtml(isBundled)}${ucv2MergedPluginFlagHtml(mergedPluginFlag)}</td><td>${versionCell}</td><td class="ucv2-keep-col">${keepCellHtml}</td><td>${escHtmlUcv2(author || '')}</td><td>${instrBtn}</td></tr>`;
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
let ucv2ApplyProgressRows = new Map();
let ucv2ApplyProgressTotal = 0;
let ucv2ApplyProgressDone = 0;

function ucv2SyncApplyProgressRows() {
  ucv2ApplyProgressRows = new Map();
  document.querySelectorAll('#ucv2ApplyProgressTableBody tr[data-ucv2-apply-mod-key]').forEach((row) => {
    ucv2ApplyProgressRows.set(row.dataset.ucv2ApplyModKey, row);
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
function ucv2UpdateApplyProgressRow(modId, key, label, title) {
  const row = ucv2ApplyProgressRows.get(String(modId));
  if (!row) return;
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
function ucv2RemoveApplyProgressRow(modId) {
  const row = ucv2ApplyProgressRows.get(String(modId));
  if (!row) return;
  row.classList.add('apply-row--leaving');
  setTimeout(() => row.remove(), 500);
}

// Actively-worked-on rows float to the top of the table (2026-08-30, director's own real catch: on a
// collection with hundreds of rows, whatever's currently happening is easy to lose track of buried
// wherever it happened to sort). Real Vortex's own Downloads/Mods lists do the same thing -- an
// in-progress item sorts to where you're actually looking, not wherever it started. A no-op if the
// row is already first (the common case once a handful of rows have already cycled through).
function ucv2MoveApplyProgressRowToTop(modId) {
  const row = ucv2ApplyProgressRows.get(String(modId));
  const body = $ucv2('ucv2ApplyProgressTableBody');
  if (!row || !body || body.firstElementChild === row) return;
  body.insertBefore(row, body.firstElementChild);
}

// Every kind of row got the SAME "Download pending" label -- read as "this is about to be
// downloaded" even for a mod that's actually about to be UNINSTALLED or just re-extracted from an
// archive already on disk, confirmed confusing live (2026-09-01, director caught it mid-apply on a
// real "Community Shaders - Cloud Shadows" removal row). Split per kind instead; nothing else about
// the pill changes (same grey 'pending' visual state) -- only the text.
const UCV2_PENDING_LABEL_BY_KIND = { remove: 'Removal pending', update: 'Update pending' };
function ucv2ApplyProgressRowHtml(modKey, name, versionText, kind) {
  const label = UCV2_PENDING_LABEL_BY_KIND[kind] || 'Download pending';
  return `<tr data-ucv2-apply-mod-key="${escHtmlUcv2(modKey)}"><td class="ucv2-apply-status-col">${ucv2ApplyPillHtml('pending', label)}</td><td>${escHtmlUcv2(name)}</td><td>${escHtmlUcv2(versionText)}</td></tr>`;
}

// The main apply's own row set: every Updated/Added mod (all of them -- Apply never skips these
// buckets), plus every Removed mod EXCEPT the ones the director explicitly chose to keep (kept mods
// are never touched by Apply at all, so they'd never receive a real mod-complete event -- showing
// them here would leave a permanent "Download pending" row nothing ever resolves).
function ucv2BuildMainApplyRows() {
  const r = ucv2CurrentReview;
  const rows = [];
  r.updated.forEach((u) => rows.push({ modKey: ucv2UpdatedModId(u), name: u.new.name, versionText: `${ucv2VersionLabel(u.old.version)} → ${ucv2VersionLabel(u.new.version)}`, kind: 'update' }));
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
  ucv2UpdateApplyStallHint(false);
  $ucv2('ucv2ApplyProgressTableBody').innerHTML = rows.map((r) => ucv2ApplyProgressRowHtml(r.modKey, r.name, r.versionText, r.kind)).join('');
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
  $ucv2('ucv2ReviewTitle').textContent = `${r.collectionName} — ${ucv2RevisionLabel()}`;
  ucv2SetScreenHeadThumb('ucv2ReviewThumb', r.pictureUrl);
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
      : ucv2RowHtml('Remove', 'status-pill--critical', m.name, m.version ? ucv2VersionLabel(m.version) : '', '', m.author, undefined))),
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
        return ucv2RowHtml(u.disabled ? 'Disabled' : 'Update', u.disabled ? 'status-pill--disabled' : 'status-pill--info', u.new.name, 'FOMOD', '', u.new.author, u.new.instructions, undefined, ucv2UpdatedModId(u), u.mergedPluginFlag,
          "The mod file is the exact same, but the collection selected different install options this time. Nothing new is downloaded—it just updates those choices.");
      }
      const modId = ucv2UpdatedModId(u);
      const note = u.installedIsNewer ? '<br><span class="muted" style="font-size:12px">Your installed version is newer</span>' : '';
      // Real live version (server-resolved via the Helper, cross-referenced against Vortex's actual
      // current mod state) wins over the collection's own stale old-revision recording whenever it
      // differs -- so a mod updated outside this collection's tracking shows what's really about to
      // happen (your real version -> the new revision's version), not a backwards-reading arrow built
      // from a pin that's no longer true. Falls back to the collection's own recording when the Helper
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
    + `<p style="margin-bottom:0">Keep Vortex open with the helper extension active to complete the process.</p>`;
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
  ucv2ConfirmApply({ ignoreDependencyBreaks: true });
});

// ---- Missing-prerequisite gate (2026-08-31, diagnostics/2026-08-30-added-mod-prerequisite-check-
// scoping.md) -- reuses the dependency-break modal's own shell/CSS classes just above, but a NEW
// body/footer: unlike that gate (one global Keep-Installed/Ignore choice for every break at once),
// this one is genuinely a PER-MOD choice (decision #1 in the scoping doc: "not a silent skip, not a
// silent auto-install" -- each affected mod needs its own real yes/no), so each row gets its own
// checkbox instead of two shared buttons. Only ever reachable from the main Apply flow
// (findMissingAddedPrerequisites is only wired into prepareApply, matching the exact same scoping
// the dependency-break gate itself already established -- "not called from prepareApplyOptional") --
// 'ucv2Screen2' is always the correct screen to return to, same reasoning as that gate's own Cancel
// handler. ----

let ucv2PendingMissingPrereqs = [];

// One row per affected Added mod. `entry.missing` can hold more than one real item (a mod can
// declare several cross-mod requirements, or one cross-mod requirement AND its own primary-file
// need) -- named together, but resolved as ONE checkbox: checking it installs every INSTALLABLE item
// this mod needs, unchecked skips the mod entirely. `installable` (2026-08-31, director's own real
// correction) is a strictly narrower set than `resolvable` -- a real, resolvable Nexus file is only
// installable when some collection the director has installed (this one or another) also genuinely
// declares it; a real Nexus requirement that nothing installed actually calls for (e.g. XPMSSE's own
// page listing FNIS as an optional requirement, genuinely wrong to auto-add into a Pandora-based
// setup that replaces FNIS entirely) gets its own distinct explanation, never a checkbox -- same as
// a genuinely off-site (not on Nexus) item, but for a different real reason, so it gets different
// copy rather than being folded into the same "isn't hosted on Nexus" message.
function ucv2MissingPrereqRowHtml(entry) {
  const installableItems = entry.missing.filter((i) => i.installable);
  // ignoredElsewhere (2026-08-31, director's own follow-up correction) checked FIRST, ahead of the
  // plain "not declared anywhere" bucket -- an item can be both resolvable and genuinely declared by
  // some installed collection, yet still not installable because the director explicitly ignored that
  // exact file somewhere; that's a deliberate choice being respected, a different real reason than
  // "nothing installed calls for this," so it gets its own copy rather than falling into that bucket.
  const ignoredItems = entry.missing.filter((i) => i.resolvable && !i.installable && i.ignoredElsewhere);
  const notInAnyCollectionItems = entry.missing.filter((i) => i.resolvable && !i.installable && !i.ignoredElsewhere);
  const unresolvableItems = entry.missing.filter((i) => !i.resolvable);
  const namesList = entry.missing.map((i) => i.name).join(', ');
  const checkboxHtml = installableItems.length > 0
    ? `<label style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px;cursor:pointer">`
      + `<input type="checkbox" class="ucv2-prereq-checkbox" data-added-key="${escHtmlUcv2(entry.addedModKey)}"> `
      + (installableItems.length === 1
        ? `Also install <strong>${escHtmlUcv2(installableItems[0].name)}</strong>`
        : `Also install the ${installableItems.length} missing mods it requires`)
      + `</label>`
      // Named directly (2026-08-31, director's own request) -- the checkbox above is only ever
      // labeled with the PREREQUISITE's name, so on its own this read as ambiguous about which mod
      // actually gets skipped when left unchecked. Names the real answer (the row's own dependent
      // mod, entry.addedModName) right where the decision is made, instead of a shared generic
      // "that mod" sentence at the bottom of the whole modal.
      + `<p style="margin:4px 0 0;font-size:13px" class="muted">Leave this unchecked and <strong>${escHtmlUcv2(entry.addedModName)}</strong> won't be installed this update.</p>`
    : '';
  const ignoredHtml = ignoredItems.length > 0
    ? `<p style="margin:6px 0 0;font-size:13px" class="muted">Also requires <strong>${escHtmlUcv2(ignoredItems.map((i) => i.name).join(', '))}</strong>, which is not installed and not included in this update. You previously chose to ignore this item, so it will remain skipped.</p>`
    : '';
  const notInAnyCollectionHtml = notInAnyCollectionItems.length > 0
    ? `<p style="margin:6px 0 0;font-size:13px" class="muted">Also requires <strong>${escHtmlUcv2(notInAnyCollectionItems.map((i) => i.name).join(', '))}</strong>, which is not part of your current installation. Please install it manually if needed, then run this update again.</p>`
    : '';
  const unresolvableHtml = unresolvableItems.length > 0
    ? `<p style="margin:6px 0 0;font-size:13px" class="muted">Also requires <strong>${escHtmlUcv2(unresolvableItems.map((i) => i.name).join(', '))}</strong>, which is not hosted on Nexus. Please install it manually, then run this update again.</p>`
    : '';
  return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border,#333)">`
    + `<strong>${escHtmlUcv2(entry.addedModName)}</strong>`
    + `<div style="font-size:13px;margin-top:2px">requires <strong>${escHtmlUcv2(namesList)}</strong>, which is not installed and not included in this update.</div>`
    + checkboxHtml + ignoredHtml + notInAnyCollectionHtml + unresolvableHtml + `</div>`;
}

function ucv2ShowMissingPrereqModal(entries) {
  ucv2PendingMissingPrereqs = entries;
  const body = $ucv2('ucv2MissingPrereqBody');
  const n = entries.length;
  // The generic "leave it unchecked to skip installing that mod" sentence used to live here as one
  // shared line for the whole modal -- ambiguous with more than one row, and even with exactly one
  // it never named which mod "that mod" meant. Each row now says so directly, right by its own
  // checkbox (see ucv2MissingPrereqRowHtml's own checkboxHtml) -- nothing generic needed here.
  body.innerHTML = `<p>${n} new mod${n === 1 ? '' : 's'} require${n === 1 ? 's' : ''} prerequisites that aren't installed. Vortex would refuse to finish installing ${n === 1 ? 'it' : 'them'}, so we're checking before making any changes.</p>`
    + entries.map(ucv2MissingPrereqRowHtml).join('');
  $ucv2('ucv2MissingPrereqModal').classList.add('open');
}
$ucv2('ucv2MissingPrereqClose').addEventListener('click', () => $ucv2('ucv2MissingPrereqModal').classList.remove('open'));
$ucv2('ucv2MissingPrereqCancel').addEventListener('click', () => {
  $ucv2('ucv2MissingPrereqModal').classList.remove('open');
  ucv2SetApplyBtnState(false, 'Apply Update →');
  ucv2GoScreen('ucv2Screen2');
});
$ucv2('ucv2MissingPrereqContinue').addEventListener('click', () => {
  // Merge into the SAME accumulator every round trip sends (see ucv2PrerequisiteChoices' own
  // declaration comment) -- a transitive prerequisite chain fires this modal more than once in one
  // overall apply attempt, and each round must add to, never replace, what an earlier round already
  // confirmed.
  ucv2PendingMissingPrereqs.forEach((entry) => {
    const cb = document.querySelector(`.ucv2-prereq-checkbox[data-added-key="${CSS.escape(entry.addedModKey)}"]`);
    ucv2PrerequisiteChoices[entry.addedModKey] = (cb && cb.checked) ? 'install' : 'skip';
  });
  $ucv2('ucv2MissingPrereqModal').classList.remove('open');
  ucv2ConfirmApply();
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
// `${modIndex}:${stepIdx}` of the step ucv2FomodRenderStep last drew -- lets it tell "genuinely
// entered a new step" apart from "just toggled an option and re-rendered the same one" (see that
// function's own comment on why it re-renders in place on every selection change).
let ucv2FomodPickerLastRenderedStepKey = null;
let ucv2FomodPickerPrevStepIdx = -1;
let ucv2FomodPickerNextStepIdx = -1;
// Which screen Cancel/Close returns to (2026-08-30) -- this picker is shared by two real gate flows
// (main Apply -> Review screen, Optional Installs -> its own screen), and since prepareApply's own
// gates now run AFTER navigating to the Apply Progress screen (see routes.js's own /apply handler),
// closing the picker has to know which screen to go back to rather than assuming whichever one was
// already showing, the way the old purely-synchronous gate could.
let ucv2FomodPickerReturnScreenId = null;

function ucv2ShowFomodPicker(needs, onDone, returnScreenId) {
  ucv2FomodPickerNeeds = needs;
  ucv2FomodPickerIndex = 0;
  ucv2FomodPickerStepIdx = 0;
  ucv2FomodPickerAnswers = {};
  ucv2FomodPickerInitedSteps = new Set();
  ucv2FomodPickerLastRenderedStepKey = null;
  ucv2FomodPickerOnDone = onDone;
  ucv2FomodPickerReturnScreenId = returnScreenId || null;
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
  // (required) (2026-08-28, director's own live catch: hit ucv2FomodValidateStep's own "needs
  // exactly one pick" refusal with no advance warning this group even had that requirement) -- same
  // two group types that refusal already gates on, so the label and the real validation can never
  // drift out of sync.
  if (group.type === 'SelectExactlyOne' || group.type === 'SelectAtLeastOne') {
    const reqSpan = document.createElement('span');
    reqSpan.className = 'muted';
    reqSpan.style.fontWeight = '400';
    reqSpan.style.textTransform = 'none';
    reqSpan.style.letterSpacing = 'normal';
    reqSpan.textContent = ' (required)';
    nameEl.appendChild(reqSpan);
  }
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
// own `onMouseOver={this.showDescription}`). Real image bytes now (2026-08-28, director's own
// build-out -- checked against Vortex's own real FOMOD wizard first, InstallerDialog.tsx's
// renderImage(): it points a plain <img> at an already-fully-extracted file, no per-hover
// extraction or data URI) -- lib/update-collection-v2-runner.js's own detectFomodChoiceNeed already
// extracted this mod's real Images/ folder up front, served here via GET /fomod-image. onerror falls
// back to the plain-text path (a genuinely missing/failed extraction, or a stale cache entry
// overwritten by a later mod's own detection pass) rather than a broken-image icon.
function ucv2FomodShowPreview(plugin, rowEl) {
  document.querySelectorAll('#ucv2FomodPickerOptions .ucv2-fomod-option.is-active').forEach((r) => r.classList.remove('is-active'));
  if (rowEl) rowEl.classList.add('is-active');
  const el = $ucv2('ucv2FomodPickerPreview');
  if (!plugin || (!plugin.image && !plugin.description)) {
    el.innerHTML = '<div class="ucv2-fomod-preview__empty">Hover over an option to see its image and description.</div>';
    return;
  }
  const need = ucv2FomodPickerNeeds[ucv2FomodPickerIndex];
  const imgSrc = plugin.image && need && need.modId
    ? `/api/update-collection-v2/fomod-image?modId=${encodeURIComponent(need.modId)}&imagePath=${encodeURIComponent(plugin.image)}`
    : null;
  const imgHtml = imgSrc
    ? `<div class="ucv2-fomod-preview__image"><img src="${escHtmlUcv2(imgSrc)}" alt="" onerror="this.parentElement.innerHTML='🖼️ ${escHtmlUcv2(plugin.image)}'"></div>`
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
  // Only a genuine step change (Next/Back, or advancing to the next mod) resets the scroll position
  // -- a re-render triggered by just toggling one option within THIS SAME step (see
  // ucv2FomodOnSelect's own comment on why it re-renders the whole step) preserves wherever you were
  // scrolled to, instead of jumping back to the top of a long options list (2026-08-28, director's
  // own live catch).
  const stepKey = `${ucv2FomodPickerIndex}:${stepIdx}`;
  const preservedScrollTop = optionsEl.scrollTop;
  const isSameStep = ucv2FomodPickerLastRenderedStepKey === stepKey;
  optionsEl.innerHTML = '';
  step.groups.forEach((group, groupIdx) => optionsEl.appendChild(ucv2FomodBuildGroupEl(need, stepIdx, group, groupIdx)));
  optionsEl.scrollTop = isSameStep ? preservedScrollTop : 0;
  ucv2FomodPickerLastRenderedStepKey = stepKey;
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
    err.innerHTML = `<div class="callout__title">⚠️ Can't advance this step</div><p>${escHtmlUcv2(error)}</p>`;
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
  ucv2SetApplyBtnState(false, 'Apply Update →');
  // This gate can now arrive via the Apply Progress stream (2026-08-30, prepareApply's own gates run
  // AFTER navigating there, not before -- see routes.js's own /apply handler) instead of only while
  // still sitting on whichever screen started it -- see ucv2ShowFomodPicker's own returnScreenId
  // comment. Only navigates when a caller actually supplied one (a no-op otherwise, matching the old
  // behavior for any call site that never needs this).
  if (ucv2FomodPickerReturnScreenId) ucv2GoScreen(ucv2FomodPickerReturnScreenId);
}
$ucv2('ucv2FomodPickerClose').addEventListener('click', ucv2CloseFomodPicker);
$ucv2('ucv2FomodPickerCancel').addEventListener('click', ucv2CloseFomodPicker);

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
function ucv2SetApplyPhase(message, current, total) {
  $ucv2('ucv2ApplyProgressPhaseText').textContent = current && total ? `${current} / ${total} — ${message}` : message;
  // Fill bar now tracks whatever phase is actually running (2026-08-30, director's own catch: it sat
  // frozen at 0% through prepareApply's own real, multi-minute pre-flight scan since only mod-complete
  // ever bumped it before -- that phase has no mod rows to complete at all). A bare 'phase' frame
  // (current/total both undefined) resets it to 0% for the new phase about to start; a 'progress'
  // frame sets it directly from THAT phase's own real current/total -- a genuinely different scale
  // than ucv2ApplyProgressTotal (the real per-mod write count), not something to reconcile with it.
  // The real write phase's own mod-complete handler (ucv2BumpApplyProgressBar) takes back over once
  // it starts firing, same as before.
  $ucv2('ucv2ApplyProgressFill').style.width = current && total ? `${Math.round((current / total) * 100)}%` : '0%';
}

// Real status vocabulary/colors (2026-08-28, director's own build spec) -- every pill here renders
// through ucv2ApplyPillHtml, the ONE shared lookup (update-collection-v2-apply-pills.js). See that
// file's own header comment for why Downloading/Installing get distinct colors and Enabled is a real
// filled pill, both deliberate overrides of real Vortex's own convention.
function ucv2HandleApplyEvent(frame) {
  ucv2ApplyLastEventAt = Date.now(); // resets the SSE-quiet fallback timer -- see ucv2StartApplyStallPolling
  if (frame.type === 'phase') {
    ucv2SetApplyPhase(frame.message);
  } else if (frame.type === 'progress') {
    ucv2SetApplyPhase(frame.message, frame.current, frame.total);
  } else if (frame.type === 'mod-start') {
    // Remove rows get their own real "Removing…" state right here -- a genuinely new capability
    // (2026-08-28); these previously had ZERO live per-mod status at all. Updated/Added rows get NO
    // visual change on mod-start -- they stay showing "Download pending" until the first real
    // mod-phase event, matching the mockup's own real behavior (mod-start isn't a distinct visual
    // state there either, only downloading/installing/enabled are).
    if (frame.kind === 'remove') {
      ucv2MoveApplyProgressRowToTop(frame.modId);
      ucv2UpdateApplyProgressRow(frame.modId, 'removing', 'Removing…');
    }
  } else if (frame.type === 'mod-phase') {
    // Refined per-row sequence (2026-08-28, director's own build spec): Download pending ->
    // Downloading... -> Extracting... -> Pending install -> Installing... [whole batch, together] ->
    // Enabled. 'downloading'/'installing' are rebuildSingleMod's own onPhase callback (its own header
    // comment explains why only these two real phase transitions exist: the underlying download call
    // has no progress signal of its own to report from) -- 'installing' here means THIS mod's own
    // real extraction, so it renders as the 'extracting' pill, not the (now batch-only) 'installing'
    // one. 'pending-install'/'batch-installing' are new events from the Added-mod loop specifically
    // (lib/update-collection-v2-runner.js): the former fires per row the instant that row's own
    // extraction finishes; the latter fires for every pending row together, at the real moment the
    // batch registration call begins.
    const PHASE_PILL = {
      downloading: ['downloading', 'Downloading…'],
      installing: ['extracting', 'Extracting…'],
      'pending-install': ['pending-install', 'Pending install'],
      'batch-installing': ['installing', 'Installing…'],
    };
    const [key, label] = PHASE_PILL[frame.phase] || ['pending', 'Working…'];
    ucv2MoveApplyProgressRowToTop(frame.modId);
    ucv2UpdateApplyProgressRow(frame.modId, key, label);
  } else if (frame.type === 'mod-complete') {
    ucv2BumpApplyProgressBar();
    // A Remove row that genuinely succeeded (or was skipped/already-done, same visual treatment --
    // nothing more to show for it) fades and vanishes instead of showing a pill that doesn't really
    // describe a removal ("Enabled" would be nonsensical here) -- matches the mockup's own real
    // behavior. A FAILED remove stays visible with a real "Failed" pill instead, same as any other
    // failure -- never silently hidden.
    if (frame.kind === 'remove') {
      if (frame.ok === false) {
        ucv2UpdateApplyProgressRow(frame.modId, 'failed', frame.error || 'Failed', frame.error || undefined);
      } else {
        ucv2RemoveApplyProgressRow(frame.modId);
      }
      return;
    }
    // A known failure status (status-labels.js's own STATUS_TEXT table, already shared by Stats
    // Report/Rebuild Collection to avoid a raw internal key leaking to the user -- see that file's
    // own header comment) gets its real label instead of a flat "Failed"; an unknown status keeps
    // the flat fallback rather than showing a raw, unrecognized key.
    const knownFailureLabel = frame.ok === false && frame.status && STATUS_TEXT[frame.status] ? statusLabel(frame.status) : null;
    // Fades and vanishes on success/skip now (2026-08-30, same real Vortex/Remove-row precedent this
    // file's own header comment already established) -- with hundreds of rows, a settled one sitting
    // there with an "Enabled" pill just buries whatever's still actually happening. A FAILED row still
    // stays put with a real pill, same as Remove -- never silently hidden. The full added/modified
    // list comes back on ucv2RenderApplyResult once everything finishes, so nothing is lost, just not
    // left cluttering the live view.
    if (frame.ok !== false) {
      ucv2RemoveApplyProgressRow(frame.modId);
      return;
    }
    const label = knownFailureLabel || 'Failed';
    ucv2UpdateApplyProgressRow(frame.modId, 'failed', label, frame.error || undefined);
  } else if (frame.type === 'done') {
    ucv2FinishApplyStream();
    // frame.optional (2026-08-28) -- set by the /apply-optional route's own 'done' frame, distinct
    // from the main /apply route's own (which never sets it, so this is falsy there). Both land on
    // the same rich ucv2RenderApplyResult, just with the optional-mods decision block suppressed the
    // second time -- that choice is already made.
    ucv2RenderApplyResult(frame.result, !!frame.optional);
  } else if (frame.type === 'error') {
    ucv2FinishApplyStream();
    // The dependency-break/FOMOD-choice/helper-unavailable gates now run AFTER the stream starts for
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
    // missing-prerequisites-found (2026-08-31) -- only ever reached via the main Apply flow, same
    // scoping the dependency-breaks-found gate above already has (findMissingAddedPrerequisites is
    // only wired into prepareApply) -- retry/returnScreen above already resolve correctly for that.
    if (frame.code === 'missing-prerequisites-found') {
      ucv2ShowMissingPrereqModal(frame.missingPrerequisites || []);
      return;
    }
    if (frame.code === 'fomod-choices-needed') {
      ucv2ShowFomodPicker(frame.fomodChoiceNeeds || [], retry, returnScreen);
      return;
    }
    if (frame.code === 'helper-unavailable') {
      window.showHelperUnavailableModal(retry);
      return;
    }
    // BACKUP_FAILED (2026-09-01, director's own exact copy, live-caught: the generic "Couldn't do
    // that" title undersold a real hard abort -- no safety backup means the apply genuinely never
    // started, not just "something didn't work").
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
    // (2026-08-30) -- prepareApply's own gates (dependency-break, FOMOD-choice, helper-unavailable)
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
      keepRemovedModIds: [...ucv2KeepRemovedModIds],
      keepInstalledModIds: [...ucv2KeepInstalledModIds],
      deleteArchives: ucv2DeleteArchives,
      fomodPicks: ucv2FomodPicks,
      prerequisiteChoices: ucv2PrerequisiteChoices,
      ...(extra || {}),
    });
  } catch (e) {
    ucv2SetApplyBtnState(false, 'Apply Update →');
    $ucv2('ucv2Loading').classList.add('hidden');
    // A real retry, not a no-op -- re-runs this SAME apply call (same extra flags, e.g. a
    // dependency-break already resolved earlier in this attempt), needed for the new
    // helper-unavailable modal's own "Try Again" to genuinely do something (2026-08-18: this was a
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
$ucv2('ucv2ApplyConfirmOk').addEventListener('click', () => ucv2ConfirmApply());

// Per-problem Retry (2026-08-23) -- ucv2ProblemMessageHtml is split out from ucv2ProblemLineHtml so a
// failed retry can rebuild just the message span in place (see the click handler below) without
// re-rendering the whole <li> (which would also mean re-attaching its own Retry button state).
function ucv2ProblemMessageHtml(label, name, message) {
  return `<strong>${escHtmlUcv2(label)}${name ? ` — ${escHtmlUcv2(name)}` : ''}:</strong> ${escHtmlUcv2(message || 'Failed.')}`;
}

function ucv2ProblemLineHtml(p, i) {
  const msgHtml = ucv2ProblemMessageHtml(p.label, p.name, p.message);
  if (!p.retry) return `<li>${msgHtml}</li>`;
  const modIdAttr = p.retry.modId ? ` data-ucv2-retry-modid="${escHtmlUcv2(p.retry.modId)}"` : '';
  return `<li data-ucv2-problem-index="${i}" data-ucv2-problem-label="${escHtmlUcv2(p.label)}" data-ucv2-problem-name="${escHtmlUcv2(p.name || '')}" style="display: flex; align-items: center; gap: 12px; justify-content: space-between;">`
    + `<span class="ucv2-problem-text">${msgHtml}</span>`
    + `<button type="button" class="btn btn--ghost btn--small ucv2-problem-retry" data-ucv2-retry-kind="${escHtmlUcv2(p.retry.kind)}"${modIdAttr}>Retry</button>`
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
    + `<button type="button" class="btn btn--ghost btn--small ucv2-problem-retry" data-ucv2-retry-kind="${escHtmlUcv2(p.retry.kind)}"${modIdAttr}>Retry</button>`
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
  const groupsHtml = groups.map((g) => `<div class="ucv2-problem-group" data-ucv2-problem-group="${escHtmlUcv2(g.label)}">`
    + `<p style="margin:10px 0 4px;font-weight:600">${escHtmlUcv2(g.heading)}</p>`
    + (g.body ? `<p style="margin:0 0 6px">${escHtmlUcv2(g.body)}</p>` : '')
    + `<ul style="margin:0 0 4px;padding-left:20px">${g.items.map((p, i) => ucv2GroupedProblemLineHtml(p, i, g.suppressMessage)).join('')}</ul>`
    + `</div>`).join('');
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

// Split out from the click listener below (2026-08-23) so the helper-unavailable modal's own "Try
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
    const res = await ucv2Api('POST', endpoint, { collectionModId: ucv2ActiveReviewModId, ...(kind === 'mod' ? { modId } : {}) });
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
    li.querySelector('.ucv2-problem-text').innerHTML = ucv2ProblemMessageHtml(li.dataset.ucv2ProblemLabel, li.dataset.ucv2ProblemName, freshMessage);
    btn.disabled = false;
    btn.textContent = 'Retry';
  } catch (err) {
    // Case 2 (DESIGN.md's "Helper-unavailable messaging" section) -- this retry is a step WITHIN the
    // SAME Apply flow that already confirmed the Helper at the start (the main Apply endpoint's own
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
    if (err.status === 409 && err.body?.error === 'helper-unavailable') {
      btn.disabled = false;
      btn.textContent = 'Retry';
      window.showHelperUnavailableModal(() => ucv2AttemptProblemRetry(btn, li, kind, modId));
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

// Shared "ThemedName (Cycle Helper)" cross-tool reference substitution (2026-08-31, extracted out of
// ucv2RenderApplyResult's own resolveProblemMessage -- now used there AND by ucv2DeployAll's own
// deploy-blocked-by-cycles handling, diagnostics/2026-08-30-real-apply-marathon-findings.md finding
// #1). The server has no access to the browser's active theme, so it sends the plain "using Cycle
// Helper" fallback wording with a distinct `code`; this is the one place that swap happens, for
// EVERY server-authored cycle message, not just the retry-pass guard's own. Only substitutes when the
// theme's own name for 'cycle-helper' actually differs from the plain "Cycle Helper" fallback (the
// plain theme's own entry IS "Cycle Helper", so this never renders the redundant "Cycle Helper (Cycle
// Helper)"). `matchCode` lets each caller gate on its own real code (`'cycle-detected'` for the
// retry-pass guard, `'deploy-blocked-by-cycles'` for the deploy-progress poll) rather than assuming
// every themed message uses the same one.
function ucv2ThemedCycleMessage(rawMessage, code, matchCode) {
  if (code !== matchCode) return rawMessage;
  const themedName = window.themedToolName ? window.themedToolName('cycle-helper', 'Cycle Helper') : 'Cycle Helper';
  const cycleHelperRef = themedName === 'Cycle Helper' ? 'Cycle Helper' : `${themedName} (Cycle Helper)`;
  return rawMessage.replace('using Cycle Helper', `using ${cycleHelperRef}`);
}

// isOptionalPass (2026-08-28) -- true only when this 'done' came from the /apply-optional route
// (frame.optional, set by ucv2HandleApplyEvent). Controls ONLY the Optional Mods Gate block at the
// bottom (ucv2RenderOptionalGateBlock below) -- every other section of this screen (success banner,
// stat cards, problems+retry) renders identically either way, since `result` has the exact same
// shape regardless of which apply pass produced it.
function ucv2RenderApplyResult(result, isOptionalPass) {
  const review = ucv2CurrentReview;
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
  // Helper)" cross-tool reference convention this app already uses elsewhere (app.js's own
  // VIEW_SUFFIXES comment, window.themedToolName) -- only shown when the theme's own name for
  // 'cycle-helper' actually differs from the plain "Cycle Helper" fallback (the plain theme's own
  // entry IS "Cycle Helper", so this never renders the redundant "Cycle Helper (Cycle Helper)").
  const resolveProblemMessage = (x) => ucv2ThemedCycleMessage(x.error, x.code, 'cycle-detected');
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
  if (!result.collectionJsonUpdated && result.coreApplyClean === false) {
    summaryIsPartial = true;
    summaryNotes.push("This update didn't finish completely—see the issues listed above. Once they're resolved, click <strong>Continue Update</strong> to finish applying your changes.");
  } else if (!result.collectionJsonUpdated) {
    summaryIsPartial = true;
    summaryNotes.push('Could not save the update record due to a file error -- the next Check for Updates may show this same diff again.');
  }
  const summary = $ucv2('ucv2ApplyResultSummary');
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
      + (problems.length > 0 ? `<div id="ucv2ApplyProblemsList">${ucv2ProblemsHtml(problems)}</div>` : '')
      + (summaryNotes.length > 0 ? `<ul id="ucv2ApplyResultSummaryNotes" style="margin:0;padding-left:20px">${summaryNotes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '');
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
    // prepareApplyOptional's own gates (HELPER_UNAVAILABLE/FOMOD_CHOICES_NEEDED) used to be checked
    // synchronously BEFORE this ever returned, which is exactly why a real 3-optional-mod submit sat
    // on a bare "Applying..." for 6+ minutes with zero indication anything was happening. They now
    // run AFTER the stream starts, arriving as error frames via GET /apply/events instead --
    // ucv2HandleApplyEvent's own 'error' branch, gated on frame.optional, handles them.
    await ucv2Api('POST', '/api/update-collection-v2/apply-optional', {
      collectionModId: ucv2ActiveReviewModId,
      optionalModKeys: mods.map(ucv2OptionalModId),
      targetRevisionNumber: r.newRevisionNumber,
      fomodPicks: ucv2FomodPicks,
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
let ucv2DeployPollInterval = null;
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

function ucv2StopDeployPolling() {
  if (ucv2DeployPollInterval) {
    clearInterval(ucv2DeployPollInterval);
    ucv2DeployPollInterval = null;
  }
  ucv2UpdateDeployStallHint(false);
}

// See ucv2DeployAll's own header comment (right above where this is called) for the full real
// reasoning. 15 ticks (the poll runs once per second) -- long enough that a normal, briefly-slow
// response never trips it, short enough that the director isn't left wondering for a full minute
// before getting a nudge to go check Vortex. Now only a FALLBACK -- see ucv2DeployStallMessage below
// for the real, helper-reported signal that fires immediately instead of waiting this out.
const UCV2_DEPLOY_STALL_THRESHOLD_TICKS = 15;
// Shared by both Deploy's own tick-count fallback and Apply's own SSE-quiet fallback below --
// renamed from the old DEPLOY-only name (2026-08-29) once Apply started using it too.
const UCV2_STALL_HINT_DEFAULT = '⚠️ Vortex is taking longer than usual to apply this update. Please be patient while it finishes.';

// Real, helper-reported fact instead of a guess (2026-08-29, replacing pure tick-count guessing --
// see diagnostics/2026-08-28-helper-live-vortex-events-spec.md). GET /mods/deploy-all/progress now
// folds in externalChangesPending/blockingDialogs, read live from Vortex's own Redux state
// (state.session.mods.changes / state.session.notifications.dialogs) by the helper -- when either is
// set, Vortex genuinely IS sitting on a dialog right now, so the hint can show immediately instead of
// waiting out UCV2_DEPLOY_STALL_THRESHOLD_TICKS. blockingDialogs' own `title` is the exact string a
// person sees in Vortex's own dialog titlebar (the helper's own read), named directly rather than
// left generic. externalChangesPending has no dialog title of its own (it's a dedicated state slice,
// not the generic dialog queue) -- returns null when neither signal is set, so the caller falls back
// to the tick-count-only default.
function ucv2DeployStallMessage(progress) {
  const dialogs = (progress && progress.blockingDialogs) || [];
  if (dialogs.length > 0 && dialogs[0].title) {
    return `⚠️ Vortex is waiting on you — check its window (<b>${escHtmlUcv2(dialogs[0].title)}</b>) to continue.`;
  }
  if (progress && progress.externalChangesPending) {
    return '⚠️ Vortex has a popup open — check it and confirm the external changes.';
  }
  return null;
}
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
function ucv2UpdateApplyStallHint(show, message) {
  ucv2UpdateStallHint('ucv2ApplyStallHint', show, message);
}

// Apply/Install's own live-signal polling (2026-08-29, director's own follow-up -- see
// diagnostics/2026-08-28-helper-live-vortex-events-spec.md's "Follow-up idea" section, and
// prompts/handoff-latest.md for the original gap this closes: mid-Apply, "is something else going
// on" had no answer on-screen, only a manual curl to the helper). Apply's real progress arrives via
// the /apply/events SSE stream (ucv2HandleApplyEvent below), not a poll -- this loop exists PURELY
// to read externalChangesPending/blockingDialogs off the SAME helper endpoint Deploy already polls
// (GET /mods/deploy-all/progress -- returns those two fields regardless of whether an actual
// deploy-all is in flight, confirmed in the original spec). The "genuinely slow, no signal" fallback
// is judged by SSE frame silence (no new /apply/events frame in UCV2_DEPLOY_STALL_THRESHOLD_TICKS
// seconds) -- Apply's own equivalent of Deploy's same-percent-same-text streak, since Apply has no
// polled percent/text of its own to compare tick-to-tick.
let ucv2ApplyPollInterval = null;
let ucv2ApplyLastEventAt = 0;
function ucv2StopApplyStallPolling() {
  if (ucv2ApplyPollInterval) {
    clearInterval(ucv2ApplyPollInterval);
    ucv2ApplyPollInterval = null;
  }
  ucv2UpdateApplyStallHint(false);
}
function ucv2StartApplyStallPolling() {
  ucv2ApplyLastEventAt = Date.now();
  ucv2ApplyPollInterval = setInterval(async () => {
    let progress;
    try {
      progress = await ucv2Api('GET', '/api/update-collection-v2/deploy-all/progress');
    } catch {
      return; // best-effort only -- a failed read here just means no fresh signal this tick
    }
    const factMessage = ucv2DeployStallMessage(progress);
    const quietMs = Date.now() - ucv2ApplyLastEventAt;
    const genuinelySlow = quietMs >= UCV2_DEPLOY_STALL_THRESHOLD_TICKS * 1000;
    ucv2UpdateApplyStallHint(!!factMessage || genuinelySlow, factMessage);
  }, 1000);
}

// Deploy success (2026-08-28, director's own flow call) -- replaces the top success banner's own
// content in place rather than showing a second, separate "deploy complete" callout further down
// the screen. The "Update complete -- one step left" banner is permanently hidden here too (not
// just toggled off for the duration of the poll via ucv2UpdateDeployBanner) -- once a deploy has
// actually succeeded there's no "one step left" left to prompt for.
function ucv2ShowDeployComplete() {
  $ucv2('ucv2ApplyResultSuccessBanner').innerHTML = '<div class="callout__title">🎉 Deploy complete — your game is ready to launch. Happy gaming!</div>';
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
    box.innerHTML = '<div class="callout__title">🎉 Deploy complete — your game is ready to launch. Happy gaming!</div>';
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

  try {
    await ucv2Api('POST', '/api/update-collection-v2/deploy-all', {});
  } catch (e) {
    ucv2DeployInFlight = false;
    $ucv2('ucv2DeployProgress').classList.add('hidden');
    ucv2HandleError(e, () => ucv2DeployAll());
    ucv2ShowDeployResult('error', e.message);
    ucv2UpdateDeployBanner();
    return;
  }

  ucv2StopDeployPolling();
  // Stall reminder (2026-08-29, director's own ask) -- a real, repeatedly-confirmed pattern this
  // whole testing session: when Vortex's own main thread is blocked (most often a native dialog it's
  // waiting on -- "External Changes", "Mod not found" -- but sometimes just genuinely heavy work,
  // e.g. an external-changes scan across a huge library), THIS poll starts failing/timing out
  // repeatedly, and the director has no way to know that from our own tool's screen -- Vortex gives
  // no indication either unless you're already looking at its window. Can't tell the two cases apart
  // from here (a blocked dialog and slow-but-real work look identical from outside), but the right
  // response is the same either way: nudge the director to go check Vortex. Tracks consecutive ticks
  // with NO real progress (a failed poll, or a successful one reporting the exact same percent/text
  // as last time) -- reset the instant real progress is seen, so a genuinely fast deploy never shows
  // this at all.
  let noProgressStreak = 0;
  let lastProgressKey = null;
  ucv2DeployPollInterval = setInterval(async () => {
    let progress;
    try {
      progress = await ucv2Api('GET', '/api/update-collection-v2/deploy-all/progress');
    } catch {
      noProgressStreak += 1;
      ucv2UpdateDeployStallHint(noProgressStreak >= UCV2_DEPLOY_STALL_THRESHOLD_TICKS);
      return; // one failed poll is not evidence the deploy failed -- try again next tick
    }
    const progressKey = progress ? `${progress.percent ?? ''}|${progress.text ?? ''}` : null;
    if (progressKey !== null && progressKey === lastProgressKey) {
      noProgressStreak += 1;
    } else {
      noProgressStreak = 0;
    }
    lastProgressKey = progressKey;
    // Real signal wins over the tick-count guess (see ucv2DeployStallMessage's own header comment) --
    // shows the instant the helper reports Vortex is genuinely blocked, named by its real dialog
    // title, rather than waiting out the old threshold. Falls back to the tick-count-only default
    // hint when neither signal is set -- a genuinely slow deploy with no dialog open still needs
    // SOME nudge.
    const factMessage = ucv2DeployStallMessage(progress);
    ucv2UpdateDeployStallHint(!!factMessage || noProgressStreak >= UCV2_DEPLOY_STALL_THRESHOLD_TICKS, factMessage);
    if (progress && typeof progress.percent === 'number') {
      $ucv2('ucv2DeployBar').style.width = `${Math.round(progress.percent)}%`;
    }
    if (progress && progress.text) $ucv2('ucv2DeployPhase').textContent = progress.text;
    if (!progress || !progress.done) return;

    ucv2StopDeployPolling(); // also clears the stall hint, see that function's own body
    ucv2DeployInFlight = false;
    $ucv2('ucv2DeployProgress').classList.add('hidden');
    // Re-enables the Back button either way (2026-08-28, director's own catch -- the success branch
    // below never called this, so a successful deploy left it disabled forever).
    ucv2UpdateDeployBanner();
    if (progress.error) {
      // deployBlockedByCycles (2026-08-31, diagnostics/2026-08-30-real-apply-marathon-findings.md
      // finding #1) -- the ONE real thing that lands here despite the Helper's own deploy call having
      // returned/resolved normally: Vortex can silently abort a deploy because of a rule cycle, so
      // "the call didn't throw" was never actually proof of success. Same theme-substitution every
      // other server-authored cycle message already gets (ucv2ThemedCycleMessage), just gated on this
      // route's own real code instead of the retry-pass guard's.
      ucv2ShowDeployResult('error', ucv2ThemedCycleMessage(progress.error, progress.code, 'deploy-blocked-by-cycles'), progress.code === 'deploy-blocked-by-cycles');
    } else {
      ucv2ShowDeployComplete();
      ucv2QuickVerifyAfterDeploy();
    }
  }, 1000);
}
// Post-deploy quick reconciliation (2026-09-01, director's own explicit design) -- see
// runner.quickVerifyAndFinalize's own header comment for the full "why". Fires automatically the
// instant Deploy finishes clean, no button click needed -- if this apply's own record was already
// fully clean there's nothing cached to check and this quietly no-ops; if something DID fail
// earlier but is now confirmed genuinely fixed, this finalizes right here so the Pick-a-collection
// screen reads "Up to date" without a separate Continue-update round trip. On any other outcome
// (still broken, helper unreachable, nothing cached) this changes nothing -- the existing
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
