'use strict';
// PGPatcher Load Order Editor -- frontend for docs/plans/2026-08-19-pgpatcher-load-order-tool.md.
// Talks to /api/pgpatcher (web/pgpatcher-routes.js), which shells out to the real pgtools.exe --
// nothing here reimplements PGPatcher's own conflict/priority logic. Skips the approved mockup's
// own Import screen entirely (director's own correction, 2026-08-19): there's no file to pick, the
// backend already merges modrules.json + the live Vortex mod list. Reuses the global `el`/`$g`
// helpers from cleanup-app.js (loaded earlier in index.html) -- no framework, same convention as
// every other *-app.js here.
//
// Built to design/load-order-editor-mockup.html's own EDITOR SCREEN interaction design (drag-and-
// drop reorder, shift/ctrl-click multi-select, Sort A-Z, search-that-highlights-not-hides, a
// distinct "New mods" panel) -- this is the first drag-and-drop list in this project (confirmed no
// existing precedent to crib from), built fresh rather than adapted from another tool's own list UI.
//
// Deliberate deviation from a literal "auto-load on open" reading of the plan: the first landing
// state is an explicit "Read mod data from PGPatcher" button (#pgpatcherIdle), not an automatic
// fetch the instant this tool-area becomes visible. The plan's own "skip straight to the editor
// screen" was about removing the file-picker Import screen, not mandating a silent multi-minute
// fetch with no way to back out first -- and every other genuinely expensive action in this project
// (Cycle Helper's Snapshot/Scan, Rebuild Collection's own run) is an explicit click, never
// auto-fired on navigation. Flagged in this item's own handoff.

async function pgpatcherApi(method, path, body, signal) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
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

// ---------- State ----------
let pgpModsByName = new Map(); // name -> full mod object from /load (isNew, priority, conflicts, shaders, enabled, ...)
let pgpRanked = [];    // mod names, top -> bottom = highest -> lowest priority
let pgpUnranked = [];  // mod names still at priority -1
let pgpOriginalRankedOrder = []; // snapshot of pgpRanked exactly as loaded, before any Sort A-Z/drag
                                  // -- lets "Priority order" restore the real priority order after
                                  // sorting A-Z to find a mod (director's own real workflow).
let pgpSelected = new Set(); // keys are `${panel}:${name}`
let pgpLastClicked = null;   // { panel, name } -- shift-click anchor
let pgpDragging = null;      // { names, fromPanel }
let pgpDirty = false;
let pgpEnabled = new Map();  // mod name -> boolean, "will this mod actually get patched" (director's
                              // own real-PGPatcher-checkbox request, color-highlighted instead of a
                              // literal checkbox per his own call). Keyed by name only (not panel) --
                              // a mod's enabled state travels with it when dragged between panels.

// Real shader-type labels for whichever patchers /load's own settings.json read says are actually
// ACTIVE right now (frame.patchers, from readPgpatcherSettings on the backend) -- confirmed real bug,
// 2026-08-19: pgtools' own texture-classification pass (PGDirectory.cpp's addToTextureMaps) tags a
// mod's `shaders` set by what TYPE each texture file looks like, unconditionally -- it does NOT check
// whether that shader's own patcher was actually requested/registered for this run. Verified live: a
// direct `pgtools conflicts truepbr` call (complexmaterial never passed) still returned
// `"shaders": ["Default", "Complex Material"]` for real mods. So `mod.shaders` alone is NOT "will
// this actually get patched" -- it has to be intersected with the patchers this run was actually
// asked to consider. Matches PGEnums::getStrFromShader's own string table (pgpatcher-fork,
// PGEnums.hpp): truepbr -> "PBR", complexmaterial -> "Complex Material", parallax -> "Parallax".
const PGP_PATCHER_ID_TO_SHADER_LABEL = { truepbr: 'PBR', complexmaterial: 'Complex Material', parallax: 'Parallax' };
let pgpActiveShaderLabels = new Set();

// Cut/Paste for the Ranked panel -- director's own real workflow: a mod sitting far down a long
// list needs to move somewhere far away, and dragging across a long scrolled list (especially after
// a Search filter) is awkward. Cut removes the selected mod(s) from pgpRanked and holds their names
// here (in their existing relative order); Paste inserts them immediately before whatever single
// mod is currently selected -- so the real move is: select, Cut, search for the destination, select
// it, Paste. Names only, never a duplicate -- there's no real "Copy" here, only "Cut" (moving a mod
// twice would just be nonsensical, a mod can't rank in two places at once).
let pgpClipboard = [];

// Real PGPatcher's own initial checkbox state for a mod PGPatcher has never seen before (isNew),
// confirmed by reading PGModManager::updateStateFromModlist directly (pgpatcher-fork,
// PGModManager.cpp ~556-566): a brand-new mod with a genuine patchable shader match starts checked.
// Deliberately NOT calling that real function from our own `pgtools conflicts` dry run to get this --
// confirmed by reading its FULL body that it does far more than set isEnabled: it also reassigns
// priority for every currently-enabled mod as a side effect of a GUI-session "sync from mod list"
// step (main.cpp:595, GUI-only, never called by any PGTools subcommand). Calling it here would
// silently re-rank the whole list on every /load and, since Save writes whatever priority the editor
// currently holds, could get written into the real modrules.json -- corrupting the exact manual
// ordering this tool exists to let the user control by hand. So only the isEnabled half is
// replicated, purely to seed this display-only toggle -- priority is never touched by this.
function pgpInitialEnabled(mod) {
  if (mod.enabled) return true; // already explicitly enabled in modrules.json -- respect it as-is
  return !!mod.isNew && Array.isArray(mod.shaders) && mod.shaders.some((s) => s !== 'Default');
}

// Clicking a toggle while it's part of a multi-selection flips every selected mod to the SAME new
// state (the opposite of the clicked row's current state) rather than flipping each one
// independently -- a mixed "some now on, some now off" result from one click would be confusing.
// Clicking a toggle NOT in the current selection only affects that one row, same as a plain click
// would reset the selection to just that row. Discoverable via the toggle's own tooltip (see
// pgpRenderList) rather than a separate control.
function pgpToggleEnabled(panel, name) {
  const key = pgpKey(panel, name);
  const bulk = pgpSelected.has(key) && pgpSelected.size > 1;
  const newState = !pgpEnabled.get(name);
  if (bulk) {
    for (const k of pgpSelected) pgpEnabled.set(k.slice(k.indexOf(':') + 1), newState);
  } else {
    pgpEnabled.set(name, newState);
  }
  pgpSetDirty();
  pgpRenderAll();
}

function pgpKey(panel, name) { return `${panel}:${name}`; }

// Panel-prefixed element id, e.g. pgpPanelId('ranked', 'SearchInput') -> 'pgpatcherRankedSearchInput'.
// Every per-panel toolbar control follows this exact convention (index.html) so pgpWireToolbar()
// below can wire up a panel generically instead of a hand-duplicated block per panel -- keeps adding
// a possible future third panel (director's own note) a matching markup block + one more call, not a
// third copy-pasted listener set.
function pgpPanelId(panel, suffix) {
  const cap = panel.charAt(0).toUpperCase() + panel.slice(1);
  return `pgpatcher${cap}${suffix}`;
}
function pgpPanelList(panel) { return panel === 'ranked' ? pgpRanked : pgpUnranked; }

function pgpSetDirty() {
  pgpDirty = true;
  $g('pgpatcherDirtyStatus').textContent = 'unsaved changes';
}

function pgpShowError(e) {
  const box = $g('pgpatcherError');
  box.textContent = '';
  const body = e && e.body;
  if (body && Array.isArray(body.downloadLinks) && body.downloadLinks.length) {
    box.appendChild(document.createTextNode(body.message || (e && e.message) || String(e)));
    const list = el('ul');
    for (const link of body.downloadLinks) {
      list.appendChild(el('li', {}, el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.label)));
    }
    box.appendChild(list);
  } else {
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'callout__title' }, '🛑 Couldn\'t complete that'));
    box.appendChild(el('p', {}, e && e.message ? e.message : String(e)));
  }
  box.classList.remove('hidden');
}
function pgpHideError() {
  $g('pgpatcherError').classList.add('hidden');
}

// The standardized "never available from the start" Helper message (DESIGN.md, "Helper-unavailable
// messaging -- two real scenarios, two different messages"). Deliberately case 1 of the two, not
// case 2's shared showHelperUnavailableModal: the check that produces this runs at the very START
// of Deploy All, before anything has been re-enabled or deployed, so nothing is half-done and
// nothing is at risk -- a flat refusal, not "it died on you partway through."
//
// Renders into #pgpatcherError, the page's own existing error box -- already a
// `callout callout--critical`, the exact element DESIGN.md's section calls for, and already used
// for structured content by pgpShowError above (its downloadLinks branch appends a real list), so
// there was no need to invent a second element.
//
// Kept separate from pgpShowError rather than folded into it: this needs the caller's own retry
// action, which pgpShowError has no way to know. Takes retryFn so a future PGPatcher endpoint that
// hard-requires the Helper can reuse it with its own action.
function pgpShowHelperUnavailable(retryFn) {
  const box = $g('pgpatcherError');
  box.textContent = '';
  box.appendChild(el('div', { class: 'callout__title' }, '🛑 Vortex Connection Required'));
  box.appendChild(el('p', {}, 'This tool requires a live connection to the Vortex Collection Helper extension to run.'));
  box.appendChild(el('ul', {}, [
    el('li', {}, [el('strong', {}, 'If you already have the extension installed:'), ' Make sure Vortex is actively running.']),
    el('li', {}, [el('strong', {}, "If you haven't installed it yet:"), ' Install the Vortex Collection Helper extension into Vortex, restart Vortex, and then launch this tool again.']),
  ]));
  // Its own right-justified row below the text, never inline with the prose -- DESIGN.md records
  // that as a real finding rather than a preference: inline, it gets lost in the copy.
  const retryBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'Retry');
  retryBtn.addEventListener('click', () => retryFn());
  box.appendChild(el('div', { style: 'display:flex; justify-content:flex-end; margin-top:10px;' }, [retryBtn]));
  box.classList.remove('hidden');
}

// Is this the Helper being unreachable, as opposed to any other failure? Matches on BOTH the status
// and the error code, the same pair cufHandleError checks -- the code alone would also match a
// different route that happened to reuse the string, and the status alone is just "conflict"
// (this route already returns a 409 for a deploy that's genuinely already running).
function pgpIsHelperUnavailable(e) {
  return e && e.status === 409 && e.body && e.body.error === 'helper-unavailable';
}

// ---------- Loading (step 1: read the data) ----------
// pgtools' own conflict/shader scan is genuinely slow (minutes, on a large install) with no single
// percent-complete signal for the whole run -- but it DOES log real phase names as each stage
// starts, and real "N/M [P%]" counts for the two heaviest stages (NIF loading, conflict-matching),
// via its own spdlog output. pgpatcher-routes.js parses those real lines and streams them here as
// SSE events (same POST-then-EventSource pattern as this project's own archive-finder-app.js) --
// this is real "where am I in the list" feedback, not a generic spinner standing in for it. A
// ticking elapsed-time counter stays alongside it for the stretches with no count at all.
let pgpLoadEventSource = null;
let pgpLoadTimerInterval = null;
let pgpLoadStartedAt = null;

function pgpStartLoadingTimer() {
  pgpLoadStartedAt = Date.now();
  $g('pgpatcherLoadingElapsed').textContent = '0:00';
  pgpLoadTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - pgpLoadStartedAt) / 1000);
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    $g('pgpatcherLoadingElapsed').textContent = `${m}:${s}`;
  }, 1000);
}
function pgpStopLoadingTimer() {
  if (pgpLoadTimerInterval) {
    clearInterval(pgpLoadTimerInterval);
    pgpLoadTimerInterval = null;
  }
}

// The callout's own title/intro used to be a fixed "Reading your mod list…" the whole time this
// screen is up -- misleading during the gate-driven deploy phases (output-mod gate, DynDoLOD's own
// wait), which can genuinely run for minutes before the real mod-list read ever starts. Swapping
// both lines to describe a deploy specifically while one's actually running, and back once it's
// past, so the header always matches what's really happening (director's own real report, 2026-08-21
// -- a screenshot showing "Deploying…" progress under a "Reading your mod list…" title).
function pgpApplyPhaseHeader(titleId, introId, message) {
  const isDeploying = /deploy/i.test(message);
  $g(titleId).textContent = isDeploying ? 'Deploying in Vortex…' : 'Reading your mod list…';
  $g(introId).textContent = isDeploying
    ? 'Vortex is relinking files for this change — this can take a few minutes.'
    : 'Reading data — this can take a few minutes on a large mod list.';
}

function pgpSetLoadingPhase(message, current, total) {
  pgpApplyPhaseHeader('pgpatcherLoadingTitle', 'pgpatcherLoadingIntro', message);
  $g('pgpatcherLoadingPhase').textContent = current && total
    ? `${current} / ${total} — ${message}`
    : message;
  const bar = $g('pgpatcherLoadingBar');
  if (current && total) {
    bar.style.width = `${Math.round((current / total) * 100)}%`;
  }
}

function pgpFinishLoading() {
  pgpStopLoadingTimer();
  if (pgpLoadEventSource) { pgpLoadEventSource.close(); pgpLoadEventSource = null; }
  $g('pgpatcherLoading').classList.add('hidden');
  pgpResetCancelBtn('pgpatcherCancelLoadBtn');
}

// The real cancel request can resolve instantly or take a genuine while depending on what pgtools is
// mid-doing when it's asked to stop -- confirmed inconsistent live (director's own report, 2026-08-21).
// Swapping the label to "Cancelling…" the moment it's clicked (and disabling it, so a second click
// can't fire a redundant request) is the only honest way to cover that gap without either lying about
// instant completion or adding a fake minimum delay. Reset back to "Cancel" happens in
// pgpFinishLoading/pgpFinishBuildingStream, the same place that already handles every real exit path
// (done/error/cancelled) for each stream, so this never needs its own separate reset logic.
function pgpSetCancelling(btnId) {
  const btn = $g(btnId);
  btn.textContent = 'Cancelling…';
  btn.disabled = true;
}
function pgpResetCancelBtn(btnId) {
  const btn = $g(btnId);
  btn.textContent = 'Cancel';
  btn.disabled = false;
}

// Generic confirm-then-retry loop for PGPatcher's own pre-flight gates (2026-08-21 -- was a single
// hardcoded dyndolod-active retry; generalized now that PGPatcher's own previous-output-mod gate can
// ALSO independently 409). Either gate can fire on any attempt, including after the other one was
// just confirmed -- keeps retrying with accumulated confirm flags until the call succeeds, or the
// user declines one of the prompts (returns null -- caller should stay put, same outcome as the old
// hard block). Any OTHER error (not-configured, a real 4xx/5xx) is re-thrown for the caller's own
// catch to handle, same as before this was pulled out into a shared helper.
async function pgpTryWithGateConfirms(method, path, baseBody) {
  const confirmFlags = {};
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await pgpatcherApi(method, path, { ...baseBody, ...confirmFlags });
    } catch (e) {
      if (e.status === 409 && e.body && e.body.error === 'dyndolod-active') {
        if (!(await showConfirmModal(e.message))) return null;
        confirmFlags.confirmDisableDyndolod = true;
        continue;
      }
      if (e.status === 409 && e.body && e.body.error === 'output-mod-active') {
        if (!(await showConfirmModal(e.message))) return null;
        confirmFlags.confirmDisableOutputMod = true;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Too many confirmation retries.');
}

// DynDoLOD.esp / PGPatcher's own previous-output-mod gates each get a real confirm modal via
// pgpTryWithGateConfirms above. Stays on whatever screen we're already on until a real load is
// genuinely about to start, only THEN transitions to the Loading screen.
async function pgpatcherLoad() {
  pgpHideError();

  let result;
  try {
    result = await pgpTryWithGateConfirms('POST', '/api/pgpatcher/load', {});
  } catch (e) {
    if (e.body && e.body.error === 'not-configured') {
      $g('pgpatcherIdle').classList.add('hidden');
      $g('pgpatcherNotConfigured').classList.remove('hidden');
    } else if (pgpIsHelperUnavailable(e)) {
      // Vortex isn't running, so the DynDoLOD/output-mod gates never even ran -- say THAT, rather
      // than letting their own "couldn't disable it automatically" message stand in for it.
      // pgpTryWithGateConfirms deliberately rethrows this rather than branching on it: it is not a
      // confirmable gate, there is nothing to say yes to.
      //
      // Retrying re-enters pgpatcherLoad from the very top, so once Vortex is open it runs the whole
      // preflight afresh and walks straight into the real DynDoLOD/output-mod confirms exactly as it
      // would have if the Helper had been reachable first time.
      pgpShowHelperUnavailable(pgpatcherLoad);
    } else {
      pgpShowError(e);
    }
    return;
  }
  if (result === null) return; // user declined a confirm -- stay put, same outcome as the old hard block

  // A real load is now genuinely running server-side -- only now switch to the Loading screen.
  $g('pgpatcherNotConfigured').classList.add('hidden');
  $g('pgpatcherIdle').classList.add('hidden');
  $g('pgpatcherEditor').classList.add('hidden');
  $g('pgpatcherLoading').classList.remove('hidden');
  $g('pgpatcherLoadingPhase').textContent = 'Starting…';
  $g('pgpatcherLoadingBar').style.width = '0%';
  // Disabled until the backend's own 'cancellable' event confirms pgtools has actually spawned --
  // cancel is a real no-op during the preflight output-mod disable+deploy step before that (real bug
  // found live, 2026-08-21: clicking it there 404s silently, but the button stayed stuck showing
  // "Cancelling…" for the rest of the run since nothing else ever reset it mid-stream). See
  // pgpHandleLoadEvent's own 'cancellable' handling below.
  $g('pgpatcherCancelLoadBtn').disabled = true;
  pgpStartLoadingTimer();

  if (pgpLoadEventSource) pgpLoadEventSource.close();
  const es = new EventSource('/api/pgpatcher/load/events');
  pgpLoadEventSource = es;
  es.onmessage = (msg) => pgpHandleLoadEvent(JSON.parse(msg.data));
}

// Shared by pgpHandleLoadEvent's/pgpHandleBuildEvent's own 'done' AND 'error' branches -- director's
// own 4-case spec (2026-08-21): DynDoLOD only ever gets offered here when the backend decided IT never
// touched it this session (still off, untouched -- see finalizeDyndolodAndOutputMod's own header
// comment in pgpatcher-routes.js); the output mod is ALWAYS offered when disabled, regardless of who
// disabled it, since its own reenable+deploy must NEVER run automatically on any exit path (a real,
// potentially multi-minute Vortex deploy the user never asked for). Sequential, never concurrent --
// showConfirmModal is a single shared modal (see shell.js's own header comment), so awaiting the first
// before opening the second avoids one silently auto-declining the other. `oneMoreStepEl` (optional)
// mirrors the build-success screen's own "one more step" reminder banner, shown once at the end if
// EITHER one is still off (declined, or the enable attempt itself failed) -- omitted for /load's own
// idle/error screens, which have no equivalent element.
async function pgpHandleReenableOffers(frame, outputModMessage, oneMoreStepEl) {
  let stillNeedsAttention = false;
  if (frame.dyndolodOfferEnable) {
    const confirmed = await showConfirmModal('DynDoLOD.esp is currently disabled. Would you like to enable it now?');
    if (confirmed) {
      try {
        await pgpatcherApi('POST', '/api/pgpatcher/enable-dyndolod', {});
      } catch (e) {
        stillNeedsAttention = true;
        pgpShowError(e);
      }
    } else {
      stillNeedsAttention = true;
    }
  }
  if (frame.outputModPendingReenable) {
    const confirmed = await showConfirmModal(outputModMessage);
    if (confirmed) pgpDeployAll(); // fire-and-forget -- its own progress UI takes over immediately
    else stillNeedsAttention = true;
  }
  if (oneMoreStepEl && stillNeedsAttention) oneMoreStepEl.classList.remove('hidden');
}

function pgpHandleLoadEvent(frame) {
  if (frame.type === 'cancellable') {
    $g('pgpatcherCancelLoadBtn').disabled = false;
  } else if (frame.type === 'phase') {
    pgpSetLoadingPhase(frame.message);
  } else if (frame.type === 'progress') {
    pgpSetLoadingPhase(frame.message, frame.current, frame.total);
  } else if (frame.type === 'done') {
    const data = frame;
    pgpModsByName = new Map(data.mods.map((m) => [m.name, m]));
    // `patchers` = this run's own active patcher ids (readPgpatcherSettings, backend) -- must be set
    // BEFORE the filters below, since pgpHasPatchableShader/pgpShaderLabel both gate on it.
    pgpActiveShaderLabels = new Set(
      (Array.isArray(data.patchers) ? data.patchers : []).map((id) => PGP_PATCHER_ID_TO_SHADER_LABEL[id]).filter(Boolean)
    );
    // Ranked panel: SECOND real correction on this same filter, 2026-08-19 -- the first pass used
    // `enabled === true` as the "keep it even without a shader match" exception, reasoning that a
    // real, manually-set checkbox state should never be silently dropped. Confirmed live this was
    // wrong for a real case: "Tomato's Riften PBR - 2k" showed here (enabled: true, a stale leftover
    // from before another mod, "...4k", started overriding it in Vortex) even though it no longer
    // contributes ANY real files and does NOT appear in real PGPatcher's own list at all. Real
    // PGPatcher's actual inclusion rule (ModSortDialog.cpp: `if (shaders.empty() && !hasMeshes)
    // continue;`) was never about `enabled` -- it's about `hasMeshes`, confirmed against real
    // captured data: the false-positive mod has `hasMeshes: false` despite `enabled: true`, while
    // "Tomato's PBR Solitude" (manually UNCHECKED, correctly still shown) has `hasMeshes: true`.
    // `hasMeshes` -- not `enabled` -- is what real PGPatcher actually keys this on. priority !== -1
    // means PGPatcher has explicitly ordered this mod before (pgpatcher-fork, PGModManager.hpp's own
    // isNew doc comment). Sorted descending by priority -- highest first at the top, matching
    // PGModManager's own getModsByPriority() and the real GUI's own ranked-list convention.
    pgpRanked = data.mods
      .filter((m) => m.priority !== -1 && (m.hasMeshes === true || pgpHasPatchableShader(m)))
      .sort((a, b) => b.priority - a.priority)
      .map((m) => m.name);
    pgpOriginalRankedOrder = [...pgpRanked]; // snapshot BEFORE anything (Sort A-Z, drag) can mutate it
    // Only show a GENUINELY NEW, patchable mod in "New mods" -- confirmed real bug, 2026-08-19:
    // `priority === -1` is NOT the same thing as `isNew`. PGModManager::loadJSON (pgpatcher-fork)
    // sets `isNew = false` for ANY mod already recorded in modrules.json, even one whose stored
    // priority is -1 (a mod PGPatcher has seen before and left explicitly unranked -- our own
    // /save route writes exactly this shape for a dragged-out mod, and a real modrules.json can
    // already carry such entries from past PGPatcher sessions). `priority === -1` alone was
    // wrongly including every one of those already-known-but-unranked mods -- confirmed live
    // against the real GUI's own count (36 shown here vs. 2 actually pink/new in PGPatcher itself).
    // `isNew` is the real, authoritative field for this -- use it directly, not the priority proxy.
    pgpUnranked = data.mods
      .filter((m) => m.isNew === true && pgpHasPatchableShader(m))
      .map((m) => m.name);
    pgpEnabled = new Map(data.mods.map((m) => [m.name, pgpInitialEnabled(m)]));
    pgpSelected.clear();
    pgpLastClicked = null;
    pgpDirty = false;
    pgpFinishLoading();
    $g('pgpatcherEditor').classList.remove('hidden');
    $g('pgpatcherLoadedCount').textContent = String(data.mods.length);
    $g('pgpatcherDirtyStatus').textContent = 'no changes yet';
    pgpRenderAll();
    // A successful load can still have a failed DynDoLOD / output-mod re-enable underneath it -- a
    // non-fatal warning shown alongside the editor (not a blocking error, the load itself genuinely
    // succeeded).
    if (data.reenableFailedMessage) pgpShowError(new Error(data.reenableFailedMessage));
  } else if (frame.type === 'error') {
    pgpFinishLoading();
    $g('pgpatcherIdle').classList.remove('hidden');
    if (!frame.cancelled) pgpShowError(new Error(frame.message || 'The load failed.'));
    pgpHandleReenableOffers(frame, 'PGPatcher’s previous output is still disabled from this run. Would you like to enable it and deploy the changes now?');
  }
}

async function pgpatcherCancelLoad() {
  pgpSetCancelling('pgpatcherCancelLoadBtn');
  try {
    await pgpatcherApi('POST', '/api/pgpatcher/load/cancel', {});
  } catch (e) {
    // Already finished or already gone -- the 'done'/'error' event (if any) will resolve the UI
    // on its own; nothing more to do here.
  }
}

// ---------- Building (step 4: the real output) ----------
// Same real-progress SSE treatment as Loading above, mirrored precisely (director's own explicit
// call, 2026-08-20: a real ~9-minute build with the sort page just sitting there read as frozen in
// real live testing) -- POST kicks off the real work, GET /build/events streams it, this tool-area
// navigates AWAY from the editor to a dedicated view for the whole thing rather than staying on the
// sort page. pgpHandleBuildEvent reuses the exact same frame shapes (phase/progress/done/error)
// pgpHandleLoadEvent already handles, just routed to the Building view's own elements and with a
// genuinely different 'done'/'error' outcome (a big success state here, vs. re-showing the editor
// with mods rendered for /load).
let pgpBuildEventSource = null;
let pgpBuildTimerInterval = null;
let pgpBuildStartedAt = null;

function pgpStartBuildingTimer() {
  pgpBuildStartedAt = Date.now();
  $g('pgpatcherBuildingElapsed').textContent = '0:00';
  pgpBuildTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - pgpBuildStartedAt) / 1000);
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    $g('pgpatcherBuildingElapsed').textContent = `${m}:${s}`;
  }, 1000);
}
function pgpStopBuildingTimer() {
  if (pgpBuildTimerInterval) {
    clearInterval(pgpBuildTimerInterval);
    pgpBuildTimerInterval = null;
  }
}

// Same dynamic-header treatment as pgpApplyPhaseHeader above, own default text since this screen's
// own "at rest" state is a real build, not a mod-list read.
function pgpApplyBuildingPhaseHeader(message) {
  const isDeploying = /deploy/i.test(message);
  $g('pgpatcherBuildingTitle').textContent = isDeploying ? 'Deploying in Vortex…' : 'Building your real output…';
  $g('pgpatcherBuildingIntro').textContent = isDeploying
    ? 'Vortex is relinking files for this change — this can take a few minutes.'
    : 'This runs the real PGPatcher build — mesh and texture patching — so it can take a while on a large mod list.';
}

function pgpSetBuildingPhase(message, current, total) {
  pgpApplyBuildingPhaseHeader(message);
  $g('pgpatcherBuildingPhase').textContent = current && total
    ? `${current} / ${total} — ${message}`
    : message;
  const bar = $g('pgpatcherBuildingBar');
  if (current && total) {
    bar.style.width = `${Math.round((current / total) * 100)}%`;
  }
}

function pgpFinishBuildingStream() {
  pgpStopBuildingTimer();
  if (pgpBuildEventSource) { pgpBuildEventSource.close(); pgpBuildEventSource = null; }
  pgpResetCancelBtn('pgpatcherCancelBuildBtn');
}

// pgpatcherApi's own body-collector, reused across the initial attempt and any confirmed retries
// (pgpTryWithGateConfirms above sends the exact same checkbox state on every retry).
function pgpBuildRequestBody() {
  return {
    considerAllMeshes: $g('pgpatcherConsiderAllMeshesInput').checked,
    relaxWeightValidation: $g('pgpatcherRelaxWeightValidationInput').checked,
  };
}

async function pgpatcherBuild() {
  pgpHideError();

  // Stays on the editor screen for this check (a real build isn't actually starting yet, so
  // switching to the Building screen just to immediately cover it with a confirm modal would be the
  // wrong sequence).
  let result;
  try {
    result = await pgpTryWithGateConfirms('POST', '/api/pgpatcher/build', pgpBuildRequestBody());
  } catch (e) {
    // The build twin of pgpatcherLoad's own branch just above -- same reasoning, same retry shape.
    if (pgpIsHelperUnavailable(e)) {
      pgpShowHelperUnavailable(pgpatcherBuild);
      return;
    }
    pgpShowError(e);
    return;
  }
  if (result === null) return; // user declined a confirm -- stay on the editor, same outcome as the old hard block

  // A real build is now genuinely running server-side -- only now switch to the Building screen and
  // start streaming its progress.
  $g('pgpatcherEditor').classList.add('hidden');
  $g('pgpatcherBuilding').classList.remove('hidden');
  $g('pgpatcherBuildingProgress').classList.remove('hidden');
  $g('pgpatcherBuildingSuccess').classList.add('hidden');
  $g('pgpatcherBuildingPhase').textContent = 'Starting…';
  $g('pgpatcherBuildingBar').style.width = '0%';
  // See pgpatcherLoad's own identical disable + comment -- same preflight-deploy bug, same fix.
  $g('pgpatcherCancelBuildBtn').disabled = true;
  pgpStartBuildingTimer();

  if (pgpBuildEventSource) pgpBuildEventSource.close();
  const es = new EventSource('/api/pgpatcher/build/events');
  pgpBuildEventSource = es;
  es.onmessage = (msg) => pgpHandleBuildEvent(JSON.parse(msg.data));
}

function pgpHandleBuildEvent(frame) {
  if (frame.type === 'cancellable') {
    $g('pgpatcherCancelBuildBtn').disabled = false;
  } else if (frame.type === 'phase') {
    pgpSetBuildingPhase(frame.message);
  } else if (frame.type === 'progress') {
    pgpSetBuildingPhase(frame.message, frame.current, frame.total);
  } else if (frame.type === 'done') {
    pgpFinishBuildingStream();
    $g('pgpatcherBuildingProgress').classList.add('hidden');
    $g('pgpatcherBuildingSuccess').classList.remove('hidden');
    $g('pgpatcherOneMoreStep').classList.add('hidden'); // reset -- only a declined enable+deploy offer below shows this again
    $g('pgpatcherDirtyStatus').textContent = 'no changes yet';
    // DynDoLOD.esp's own re-enable is automatic and immediate WHEN this session itself disabled it
    // (free, no deploy needed) -- but per the director's own 4-case spec (2026-08-21), if it was
    // already off before this tool ever touched it, it's offered as a confirm instead (frame.
    // dyndolodOfferEnable) rather than silently flipped, handled below by pgpHandleReenableOffers. A
    // successful build can still have a failed DynDoLOD AUTO-reenable underneath it -- a non-fatal
    // warning shown alongside the success screen, not a blocking error.
    if (frame.reenableFailedMessage) pgpShowError(new Error(frame.reenableFailedMessage));
    // The output mod is ALWAYS "pending" here when disabled, regardless of who disabled it -- see
    // web/pgpatcher-routes.js's own comment on why ITS re-enable stays gated behind this confirm
    // (it genuinely needs a real full deploy to relink its files). Fired AFTER the success screen
    // itself is already showing, not blocking it. pgpDeployAll() -> POST /api/pgpatcher/deploy-all is
    // what actually re-enables it AND runs the real full deploy, in that order, as one combined
    // action -- accepting this prompt IS the re-enable, not a separate step after one already happened.
    // Sequential with any DynDoLOD offer above -- see pgpHandleReenableOffers's own header comment.
    pgpHandleReenableOffers(frame, 'The build is complete. Would you like to enable PGPatcher’s new output and deploy the changes?', $g('pgpatcherOneMoreStep'));
  } else if (frame.type === 'error') {
    pgpFinishBuildingStream();
    $g('pgpatcherBuilding').classList.add('hidden');
    $g('pgpatcherEditor').classList.remove('hidden');
    if (!frame.cancelled) pgpShowError(new Error(frame.message || 'The build failed.'));
    pgpHandleReenableOffers(frame, 'PGPatcher’s previous output is still disabled from this run. Would you like to enable it and deploy the changes now?');
  }
}

// Real, full Vortex "Deploy Mods" pipeline (POST /api/pgpatcher/deploy-all), offered only right after
// a build that itself disabled PGPatcher's own previous-output mod and hasn't re-enabled it yet --
// see pgpHandleBuildEvent's own outputModPendingReenable check above (DynDoLOD.esp's own re-enable no
// longer goes through this at all -- it's immediate server-side, see that check's own comment). This
// IS the re-enable (the backend flips the flag first, then deploys), not a separate step after one
// already happened. Poll-driven, not SSE -- the
// backend's own deployAllMods()/getDeployAllProgress() pair is itself poll-shaped
// (lib/vortex-helper-client.js), so this reuses that same shape rather than wrapping it in an SSE
// session the underlying primitive doesn't have. Reuses the SAME progress-bar/phase-text visual
// pattern the build's own progress view already established (pgpSetBuildingPhase), just against the
// deploy-specific elements.
let pgpDeployAllPollInterval = null;

function pgpStopDeployAllPolling() {
  if (pgpDeployAllPollInterval) {
    clearInterval(pgpDeployAllPollInterval);
    pgpDeployAllPollInterval = null;
  }
}

async function pgpDeployAll() {
  $g('pgpatcherDeployAllDone').classList.add('hidden');
  $g('pgpatcherDeployAllProgress').classList.remove('hidden');
  $g('pgpatcherDeployAllPhase').textContent = 'Starting…';
  $g('pgpatcherDeployAllBar').style.width = '0%';
  // Restarting mid-deploy would abandon a real, still-running Vortex write -- disabled for the whole
  // deploy, re-enabled once it's actually done (success or error), same guard shape as the Cancel
  // buttons' own "Cancelling…" disable elsewhere in this file.
  $g('pgpatcherBuildingBackToEditorBtn').disabled = true;

  try {
    await pgpatcherApi('POST', '/api/pgpatcher/deploy-all', {});
  } catch (e) {
    $g('pgpatcherDeployAllProgress').classList.add('hidden');
    $g('pgpatcherBuildingBackToEditorBtn').disabled = false;
    // Deploy All is the one PGPatcher action that genuinely cannot work without the Helper -- it
    // runs Vortex's own real deploy through it, with no read-only fallback. That earns the
    // standardized callout and a Retry rather than a bare error dump, since "start Vortex and try
    // again" is a real, achievable fix the user can act on right there.
    if (pgpIsHelperUnavailable(e)) {
      pgpShowHelperUnavailable(pgpDeployAll);
      return;
    }
    pgpShowError(e);
    return;
  }

  pgpStopDeployAllPolling();
  pgpDeployAllPollInterval = setInterval(async () => {
    let progress;
    try {
      progress = await pgpatcherApi('GET', '/api/pgpatcher/deploy-all/progress');
    } catch (e) {
      return; // A single failed poll isn't evidence the real deploy failed -- just try again next tick.
    }
    if (progress && typeof progress.percent === 'number') {
      $g('pgpatcherDeployAllBar').style.width = `${Math.round(progress.percent)}%`;
    }
    if (progress && progress.text) {
      $g('pgpatcherDeployAllPhase').textContent = progress.text;
    }
    if (progress && progress.done) {
      pgpStopDeployAllPolling();
      $g('pgpatcherDeployAllProgress').classList.add('hidden');
      $g('pgpatcherBuildingBackToEditorBtn').disabled = false;
      if (progress.error) {
        pgpShowError(new Error(progress.error));
      } else {
        $g('pgpatcherDeployAllDone').classList.remove('hidden');
      }
    }
  }, 1000);
}

async function pgpatcherCancelBuild() {
  pgpSetCancelling('pgpatcherCancelBuildBtn');
  try {
    await pgpatcherApi('POST', '/api/pgpatcher/build/cancel', {});
  } catch (e) {
    // Already finished or already gone -- the 'done'/'error' event (if any) will resolve the UI
    // on its own; nothing more to do here.
  }
}

// ---------- Row rendering ----------
function pgpModNames(list) { return list; } // list is already plain names -- kept for readability at call sites

// Shared by the Ranked and New Mods filters (pgpHandleLoadEvent) -- "does this mod have a real,
// currently-ACTIVE shader match". Two gates, both required: not "Default" (pgtools' own no-op
// placeholder), AND in `pgpActiveShaderLabels` (this run's own active patchers -- pgtools' texture
// classification tags a shader type regardless of whether that patcher was actually requested, see
// this file's own top-of-file comment on PGP_PATCHER_ID_TO_SHADER_LABEL).
function pgpHasPatchableShader(mod) {
  return Array.isArray(mod.shaders) && mod.shaders.some((s) => s !== 'Default' && pgpActiveShaderLabels.has(s));
}

// Real PGPatcher's own Shader column (ModSortDialog.cpp's constructShaderString): every non-Default,
// currently-ACTIVE shader value on the mod, joined with ", " -- same active-patcher gate as
// pgpHasPatchableShader above, so this never shows a shader type that isn't actually enabled right
// now. pgtools already sends `shaders` pre-sorted worst-to-best (the same order the real GUI's own
// std::set<ShapeShader> iterates in), so this doesn't need to re-derive that ordering.
function pgpShaderLabel(name) {
  const mod = pgpModsByName.get(name);
  if (!mod || !Array.isArray(mod.shaders)) return '';
  return mod.shaders.filter((s) => s !== 'Default' && pgpActiveShaderLabels.has(s)).join(', ');
}

// Ranked panel display order (director-confirmed, 2026-08-19, matches real PGPatcher's own Set Mods
// list): checked mods first, unchecked ones grouped at the bottom -- DISPLAY ONLY. A stable partition
// of `names` (each group keeps its existing relative order), never touching `pgpRanked` itself --
// the real array Save/Sort A-Z/Priority order/drag-drop all still use. So an unchecked mod's actual
// saved priority is untouched by this regrouping; only where it RENDERS moves. Confirmed director's
// own call: re-checking a mod later should NOT require dragging it back into place.
function pgpRankedDisplayOrder(names) {
  const checked = [];
  const unchecked = [];
  for (const name of names) (pgpEnabled.get(name) ? checked : unchecked).push(name);
  return [...checked, ...unchecked];
}

function pgpRenderList(panel, names, containerId) {
  const container = $g(containerId);
  // Reads THIS panel's own search box, not a single shared one -- confirmed live bug: one global
  // search input filtered/highlighted matches in both panels at once from the same keystroke.
  const filter = $g(pgpPanelId(panel, 'SearchInput')).value.trim().toLowerCase();
  container.innerHTML = '';
  let firstMatchRow = null;
  const displayNames = panel === 'ranked' ? pgpRankedDisplayOrder(names) : names;
  displayNames.forEach((name, idx) => {
    // Real PGPatcher's own pain point (director-confirmed via the approved mockup): searching used
    // to filter the list down to just the match, hiding everything around it -- losing all context
    // for where a mod sits relative to its neighbors, which matters when you're about to drag a new
    // mod in next to it. Every row stays visible here; a match just gets highlighted (and the FIRST
    // match auto-scrolls into view), non-matches dim instead of disappearing.
    const isMatch = filter && name.toLowerCase().includes(filter);
    const k = pgpKey(panel, name);
    const row = el('div', {
      class: 'pgp-row' + (pgpSelected.has(k) ? ' selected' : '') + (isMatch ? ' search-match' : ''),
      draggable: 'true',
      'data-panel': panel,
      'data-name': name,
    });
    if (isMatch && !firstMatchRow) firstMatchRow = row;
    row.appendChild(el('span', { class: 'pgp-row__handle' }, '::'));

    // Real PGPatcher's own "will this mod actually be patched" checkbox (Set Mods dialog) -- color
    // highlight here per the director's own call, not a literal checkbox glyph. Ranked panel ONLY
    // (director's own explicit correction): every New Mods row is already known-patchable by
    // construction (that's the whole point of the New Mods filter -- pgpatcher-new-mods-filter-and-
    // dyndolod-gate), so a toggle there would always read as checked and add nothing. Its own click
    // target, deliberately separate from the row's click-to-select handler below (stopPropagation) so
    // toggling it doesn't also change the selection.
    if (panel === 'ranked') {
      const modEnabled = pgpEnabled.get(name);
      const isBulkTarget = pgpSelected.has(k) && pgpSelected.size > 1;
      const toggle = el('span', {
        class: 'pgp-row__toggle' + (modEnabled ? ' enabled' : ''),
        title: (modEnabled ? 'Will be patched' : "Won't be patched")
          + (isBulkTarget ? ` — click to toggle all ${pgpSelected.size} selected mods` : ' — click to toggle'),
      });
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        pgpToggleEnabled(panel, name);
      });
      row.appendChild(toggle);
    }

    if (panel === 'ranked') row.appendChild(el('span', { class: 'pgp-row__rank' }, String(idx + 1)));
    row.appendChild(el('span', { class: 'pgp-row__name' }, name));
    const shaderLabel = pgpShaderLabel(name);
    if (shaderLabel) row.appendChild(el('span', { class: 'pgp-row__shader' }, shaderLabel));

    row.addEventListener('click', (e) => {
      // KNOWN GAP, flagged rather than silently accepted: shift-click range-select still spans the
      // REAL pgpRanked order, not the checked-first DISPLAY order above -- so a shift-click between
      // two rows that are visually adjacent (both in the checked group) but far apart in real
      // priority will select everything real-priority-between them, not just what's visually
      // between them. Matches this app's existing "range = underlying list order" behavior; revisit
      // if it reads wrong in practice.
      if (e.shiftKey && pgpLastClicked && pgpLastClicked.panel === panel) {
        const list = panel === 'ranked' ? pgpRanked : pgpUnranked;
        const a = list.indexOf(pgpLastClicked.name);
        const b = list.indexOf(name);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) pgpSelected.add(pgpKey(panel, list[i]));
      } else if (e.ctrlKey || e.metaKey) {
        if (pgpSelected.has(k)) pgpSelected.delete(k); else pgpSelected.add(k);
      } else {
        pgpSelected.clear();
        pgpSelected.add(k);
      }
      pgpLastClicked = { panel, name };
      pgpRenderAll();
    });

    row.addEventListener('dragstart', () => {
      // Deliberately does NOT call pgpRenderAll() here even if this row wasn't already selected --
      // that would rebuild the DOM mid-drag and destroy the element the browser is currently
      // dragging, silently breaking the drop (same reasoning the approved mockup's own JS documents).
      if (!pgpSelected.has(k)) { pgpSelected.clear(); pgpSelected.add(k); }
      const draggedNames = [...pgpSelected].filter((s) => s.startsWith(panel + ':')).map((s) => s.slice(panel.length + 1));
      pgpDragging = { names: draggedNames, fromPanel: panel };
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (pgpDragging) pgpHandleDrop(panel, name);
    });

    container.appendChild(row);
  });
  if (firstMatchRow) firstMatchRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
  container.addEventListener('dragover', (e) => e.preventDefault());
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    if (pgpDragging && e.target === container) pgpHandleDrop(panel, null); // drop at end of list
  });
}

function pgpHandleDrop(targetPanel, beforeName) {
  if (!pgpDragging) return;
  const { names, fromPanel } = pgpDragging;
  const fromList = fromPanel === 'ranked' ? pgpRanked : pgpUnranked;
  for (let i = fromList.length - 1; i >= 0; i--) {
    if (names.includes(fromList[i])) fromList.splice(i, 1);
  }
  const toList = targetPanel === 'ranked' ? pgpRanked : pgpUnranked;
  let insertAt = toList.length;
  if (beforeName) {
    const foundAt = toList.indexOf(beforeName);
    if (foundAt !== -1) insertAt = foundAt;
  }
  toList.splice(insertAt, 0, ...names);
  pgpDragging = null;
  pgpSetDirty();
  pgpRenderAll();
}

// Win/lose highlight against whichever mod(s) are currently selected. Confirmed from PGPatcher's
// own real source (pgpatcher-fork, PGPatcher/src/GUI/ModSortDialog.cpp, highlightConflictingItems):
// "The mod you have selected wins over mods that are green, and loses over mods that are red" --
// and mechanically, a conflicting mod at a list index BELOW the selected mod's index is winning
// (green), ABOVE is losing (red). This is pure list-position + conflict-adjacency (from each mod's
// own `conflicts` list, already in the /load response) -- never asks PGPatcher to compute it.
// Only meaningful within the Ranked panel: a conflict against an unranked (-1 priority) mod has no
// resolved winner/loser yet, so those are left unhighlighted.
function pgpApplyConflictHighlights() {
  document.querySelectorAll('.pgp-row.conflict-winning, .pgp-row.conflict-losing').forEach((r) => {
    r.classList.remove('conflict-winning', 'conflict-losing');
  });
  // Director's own ask, 2026-08-19: a real toggle, since this isn't something the native PGPatcher
  // GUI exposes on its own -- easy to click past without meaning to.
  if (!$g('pgpatcherConflictHighlightToggle').checked) return;
  if (pgpSelected.size === 0) return;
  const selectedNames = new Set([...pgpSelected].map((k) => k.slice(k.indexOf(':') + 1)));
  for (const selName of selectedNames) {
    const selIdx = pgpRanked.indexOf(selName);
    if (selIdx === -1) continue; // the selected mod itself isn't ranked -- nothing to compare against
    const mod = pgpModsByName.get(selName);
    if (!mod) continue;
    for (const conflictName of mod.conflicts) {
      if (selectedNames.has(conflictName)) continue; // don't highlight another selected row
      const idx = pgpRanked.indexOf(conflictName);
      if (idx === -1) continue; // conflicting mod isn't ranked either -- no resolved winner yet
      const row = document.querySelector(`.pgp-row[data-panel="ranked"][data-name="${CSS.escape(conflictName)}"]`);
      if (!row) continue;
      row.classList.add(idx < selIdx ? 'conflict-losing' : 'conflict-winning');
    }
  }
}

function pgpRenderAll() {
  pgpRenderList('ranked', pgpModNames(pgpRanked), 'pgpatcherRankedList');
  pgpRenderList('unranked', pgpModNames(pgpUnranked), 'pgpatcherUnrankedList');
  $g('pgpatcherRankedCount').textContent = `${pgpRanked.length} mods`;
  $g('pgpatcherUnrankedCount').textContent = `${pgpUnranked.length} mods`;
  // Two separate selection counts, one per panel toolbar -- not one combined total. Select
  // all/Invert/Clear are now panel-scoped (only touch that panel's own keys), so a count next to
  // that toolbar should answer "how many rows in THIS panel are selected", matching what its own
  // buttons actually act on. A cross-panel selection (ctrl-click spanning both) is still possible --
  // it just shows up as a nonzero count in both panels' own readouts rather than one merged number.
  for (const panel of ['ranked', 'unranked']) {
    const n = [...pgpSelected].filter((sk) => sk.startsWith(panel + ':')).length;
    $g(pgpPanelId(panel, 'SelectionCount')).textContent = n > 0 ? `${n} selected` : '';
  }
  pgpApplyConflictHighlights();
  pgpUpdateCutPasteButtons();
}

// ---------- Toolbar actions ----------
// One toolbar per panel, each scoped to only that panel's own list/selection (see index.html's own
// comment on the split) -- wired generically by panel name via pgpPanelId() rather than a hand-
// duplicated listener block per panel, so a possible future third panel only needs one more call
// here plus a matching markup block.
function pgpWireToolbar(panel) {
  $g(pgpPanelId(panel, 'SearchInput')).addEventListener('input', pgpRenderAll);
  $g(pgpPanelId(panel, 'SortAzBtn')).addEventListener('click', () => {
    pgpPanelList(panel).sort((a, b) => a.localeCompare(b));
    pgpSetDirty();
    pgpRenderAll();
  });
  $g(pgpPanelId(panel, 'SelectAllBtn')).addEventListener('click', () => {
    pgpPanelList(panel).forEach((name) => pgpSelected.add(pgpKey(panel, name)));
    pgpRenderAll();
  });
  $g(pgpPanelId(panel, 'ClearSelBtn')).addEventListener('click', () => {
    for (const sk of [...pgpSelected]) if (sk.startsWith(panel + ':')) pgpSelected.delete(sk);
    pgpRenderAll();
  });
  $g(pgpPanelId(panel, 'InvertBtn')).addEventListener('click', () => {
    pgpPanelList(panel).forEach((name) => {
      const k = pgpKey(panel, name);
      if (pgpSelected.has(k)) pgpSelected.delete(k); else pgpSelected.add(k);
    });
    pgpRenderAll();
  });
}
pgpWireToolbar('ranked');
pgpWireToolbar('unranked');
$g('pgpatcherConflictHighlightToggle').addEventListener('change', pgpApplyConflictHighlights);

// Ranked panel only -- director's own real workflow: Sort A-Z to FIND a mod, then need a way back to
// the real priority order without reloading from PGPatcher. Restores pgpOriginalRankedOrder's own
// relative order for every mod still ranked; anything dragged INTO ranked since load (not in that
// snapshot) is appended at the end, preserving its current relative order among itself -- never
// silently drops a mod the director dragged in. A mod dragged OUT to New Mods since load is simply
// no longer in pgpRanked at all, so it's correctly left alone (still in New Mods, not resurrected).
$g('pgpatcherRankedPriorityOrderBtn').addEventListener('click', () => {
  const snapshotSet = new Set(pgpOriginalRankedOrder);
  const stillPresent = pgpOriginalRankedOrder.filter((name) => pgpRanked.includes(name));
  const draggedInSince = pgpRanked.filter((name) => !snapshotSet.has(name));
  pgpRanked = [...stillPresent, ...draggedInSince];
  pgpSetDirty();
  pgpRenderAll();
});

// Cut/Paste (Ranked panel only) -- see pgpClipboard's own top-of-file comment for the real
// workflow this solves. Cut needs at least one ranked mod selected; Paste needs the clipboard
// non-empty AND exactly one ranked mod selected (the destination anchor) -- both buttons' own
// enabled state is kept current by pgpUpdateCutPasteButtons(), called from pgpRenderAll.
$g('pgpatcherRankedCutBtn').addEventListener('click', () => {
  const cutNames = pgpRanked.filter((name) => pgpSelected.has(pgpKey('ranked', name)));
  if (cutNames.length === 0) return;
  pgpClipboard = cutNames;
  pgpRanked = pgpRanked.filter((name) => !pgpSelected.has(pgpKey('ranked', name)));
  for (const name of cutNames) pgpSelected.delete(pgpKey('ranked', name));
  pgpSetDirty();
  pgpRenderAll();
});
$g('pgpatcherRankedPasteBtn').addEventListener('click', () => {
  const selectedRanked = pgpRanked.filter((name) => pgpSelected.has(pgpKey('ranked', name)));
  if (pgpClipboard.length === 0 || selectedRanked.length !== 1) return;
  const anchor = selectedRanked[0];
  const anchorIdx = pgpRanked.indexOf(anchor);
  pgpRanked.splice(anchorIdx, 0, ...pgpClipboard);
  // Select what was just pasted, not the anchor -- confirms at a glance where it actually landed.
  pgpSelected.clear();
  for (const name of pgpClipboard) pgpSelected.add(pgpKey('ranked', name));
  pgpLastClicked = { panel: 'ranked', name: pgpClipboard[pgpClipboard.length - 1] };
  pgpClipboard = [];
  pgpSetDirty();
  pgpRenderAll();
});
function pgpUpdateCutPasteButtons() {
  const selectedRankedCount = pgpRanked.filter((name) => pgpSelected.has(pgpKey('ranked', name))).length;
  $g('pgpatcherRankedCutBtn').disabled = selectedRankedCount === 0;
  const pasteBtn = $g('pgpatcherRankedPasteBtn');
  pasteBtn.disabled = pgpClipboard.length === 0 || selectedRankedCount !== 1;
  pasteBtn.innerHTML = pgpClipboard.length > 0
    ? `&#128203; Paste ${pgpClipboard.length} mod${pgpClipboard.length === 1 ? '' : 's'} here`
    : '&#128203; Paste';
}

// CSV export -- director's own ask: people compare load orders with each other, so a plain rank/
// name/shader dump is genuinely useful outside the app, not just a nice-to-have. Same rank numbers
// and order the panel is CURRENTLY showing (checked-first, per pgpRankedDisplayOrder) -- exporting
// what's on screen, not the raw save order underneath it, is what actually matches what someone is
// looking at when they hit the button.
function pgpCsvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
$g('pgpatcherRankedExportBtn').addEventListener('click', () => {
  const displayNames = pgpRankedDisplayOrder(pgpRanked);
  const rows = [['Rank', 'Mod', 'Shader']];
  displayNames.forEach((name, idx) => {
    rows.push([idx + 1, name, pgpShaderLabel(name)]);
  });
  const csv = rows.map((row) => row.map(pgpCsvField).join(',')).join('\r\n') + '\r\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `pgpatcher-ranked-mods-${stamp}.csv` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

// ---------- Footer actions (steps 3 & 4) ----------

// Director's own real complaint: leaving the editor (Home, then back) lands right back on the
// editor screen -- this app never re-fetches on re-entry, so that's expected -- but there was no
// way to actually back OUT of it without either a full "Reload from PGPatcher" (a real multi-minute
// re-scan) or committing to Save/Build. This just resets to the Idle landing screen, no network
// call, same dirty-changes confirm Reload already has.
//
// showConfirmModal (work-through-app.js, #wtConfirmModal) instead of the native confirm() -- director's
// own correction, 2026-08-19: a plain browser confirm() dialog reads jarringly out of theme. This
// reuses the same shared, already-themed confirm modal every other tool in this project already
// uses for exactly this "are you sure" pattern, rather than inventing a PGPatcher-only one.
function pgpResetToIdle() {
  pgpFinishLoading(); // defensive -- stops a stray load timer/EventSource if one somehow survived
  pgpFinishBuildingStream(); // same, for a stray build timer/EventSource
  pgpStopDeployAllPolling(); // same, for a stray deploy-all poll if one somehow survived
  pgpModsByName = new Map();
  pgpRanked = [];
  pgpUnranked = [];
  pgpOriginalRankedOrder = [];
  pgpSelected.clear();
  pgpLastClicked = null;
  pgpEnabled = new Map();
  pgpDirty = false;
  pgpHideError();
  $g('pgpatcherEditor').classList.add('hidden');
  $g('pgpatcherBuilding').classList.add('hidden');
  $g('pgpatcherIdle').classList.remove('hidden');
}

$g('pgpatcherStartOverBtn').addEventListener('click', async () => {
  if (pgpDirty && !(await showConfirmModal('You have unsaved changes that will be lost. Start over anyway?'))) return;
  pgpResetToIdle();
});

$g('pgpatcherReloadBtn').addEventListener('click', async () => {
  if (pgpDirty && !(await showConfirmModal('You have unsaved changes that will be lost. Reset anyway?'))) return;
  pgpatcherLoad();
});

window.pgpResetToIdle = pgpResetToIdle;

async function pgpatcherSaveOrder() {
  pgpHideError();
  try {
    const result = await pgpatcherApi('POST', '/api/pgpatcher/save', {
      order: pgpRanked,
      unranked: pgpUnranked,
      enabled: Object.fromEntries(pgpEnabled),
    });
    pgpDirty = false;
    $g('pgpatcherDirtyStatus').textContent = `saved — backed up to ${result.backupPath}`;
    return true;
  } catch (e) {
    pgpShowError(e);
    return false;
  }
}

$g('pgpatcherSaveBtn').addEventListener('click', async () => {
  const btn = $g('pgpatcherSaveBtn');
  btn.disabled = true;
  await pgpatcherSaveOrder();
  btn.disabled = false;
});

$g('pgpatcherBuildBtn').addEventListener('click', async () => {
  const btn = $g('pgpatcherBuildBtn');
  btn.disabled = true;
  const saved = await pgpatcherSaveOrder();
  btn.disabled = false; // the button lives on the editor screen, about to be hidden either way --
                         // re-enabled now so it's back to normal whenever the editor next shows again
                         // (only on a failed build -- a successful one starts a fresh session instead
                         // of returning here), not left disabled from this click.
  if (!saved) return;
  await pgpatcherBuild();
});

$g('pgpatcherCancelBuildBtn').addEventListener('click', pgpatcherCancelBuild);
// A completed build isn't something to go "back" from -- the mod list Vortex reports could easily
// have changed since (re-enabling mods for Deploy, etc.), so this starts a genuinely fresh session
// (same reset pgpatcherStartOverBtn uses) rather than reopening the now-stale editor state
// (director's own call, 2026-08-20).
$g('pgpatcherBuildingBackToEditorBtn').addEventListener('click', () => {
  pgpResetToIdle();
});

// ---------- Idle screen ----------
$g('pgpatcherLoadBtn').addEventListener('click', pgpatcherLoad);
$g('pgpatcherCancelLoadBtn').addEventListener('click', pgpatcherCancelLoad);
$g('pgpatcherGoToSettings').addEventListener('click', (e) => {
  e.preventDefault();
  navigateToArea('settings');
  if (typeof showSettingsCategory === 'function') showSettingsCategory('pgpatcher');
});

// Landing state: idle, with an explicit "Read mod data" button -- see this file's own header
// comment for why this isn't an automatic fetch on area-open.
$g('pgpatcherIdle').classList.remove('hidden');
