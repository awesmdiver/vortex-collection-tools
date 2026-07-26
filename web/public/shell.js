'use strict';
// Minimal top-level nav shared by every tool area in this project -- deliberately dumb (a flat
// list of registered areas) so adding a future 3rd/4th Vortex tool area later is "register one
// more entry", not a redesign. Each area is a plain <section class="tool-area"> already present in
// index.html; this only toggles which one is visible. app.js and sync-app.js each own their own
// internal view-state exactly as before -- this file knows nothing about either.

const TOOL_AREAS = ['rebuild', 'sync', 'settings', 'reports'];
let currentArea = null;

// "What page am I on" was genuinely hard to tell across several of this app's pages -- confirmed
// live, a real screenshot with no on-page label besides an inferrable heading + which back-button
// text happened to show. #headerMeta already existed in the header markup but was never actually
// used for anything -- repurposed here as a persistent, always-visible label, and mirrored into the
// browser tab title too, so either a screenshot OR just hovering the tab answers the question.
// Exposed on window so app.js (view-picker/plan/progress/summary/logs, all within area-rebuild) and
// stats-app.js (the Reports sub-tabs) can refine it further once their own navigation runs -- each
// area's showToolArea() call here sets a reasonable default first, then gets overridden with
// something more specific a moment later by whichever script owns that area's own view-state.
function setPageLabel(label) {
  const el = document.getElementById('headerMeta');
  if (el) el.textContent = label;
  document.title = label ? `Vortex Collection Tools — ${label}` : 'Vortex Collection Tools';
}
window.setPageLabel = setPageLabel;

// A fetch() that can't even connect (the server process is fully down, nothing listening at all)
// rejects with a plain TypeError -- no HTTP status, unlike a normal 4xx/5xx response, which every
// page's own api() helper already turns into an Error with .status set before it ever reaches a
// caller. Each page checks this itself (own api() helper, own try/catch shape) rather than this file
// wrapping fetch for them -- same "each area owns its own state" convention as everything else here.
function isServerUnreachableError(e) {
  return e instanceof TypeError;
}
window.isServerUnreachableError = isServerUnreachableError;

// retryFn: what "Try Again" should re-run -- same pattern as app.js's own pendingVortexRetry, just
// one level up so every page can share it instead of each reimplementing this exact modal.
let pendingServerUnreachableRetry = null;
function showServerUnreachableError(retryFn) {
  pendingServerUnreachableRetry = retryFn || null;
  document.getElementById('serverUnreachableModal').classList.remove('hidden');
}
window.showServerUnreachableError = showServerUnreachableError;
document.getElementById('serverUnreachableCloseBtn').addEventListener('click', () => {
  document.getElementById('serverUnreachableModal').classList.add('hidden');
});
document.getElementById('serverUnreachableRetryBtn').addEventListener('click', () => {
  document.getElementById('serverUnreachableModal').classList.add('hidden');
  if (pendingServerUnreachableRetry) pendingServerUnreachableRetry();
});

// Replaces the old #vortexBanner (Rebuild Collection) / #syncVortexBanner (Update Collection) --
// each was scroll-to-top-on-show since neither was fixed/sticky, meaning triggering it moved the
// user away from wherever they were. A shared centered modal (same shape as
// showServerUnreachableError above) never depends on scroll position at all, so the user keeps
// their place on the page. hideVortexRunningModal is exported too -- callers that already know an
// action just succeeded (so any earlier "Vortex is running" modal from a prior failed attempt is
// now stale) can dismiss it without waiting for the user to click Close themselves.
let pendingVortexRunningRetry = null;
function showVortexRunningModal(retryFn) {
  pendingVortexRunningRetry = retryFn || null;
  document.getElementById('vortexRunningModal').classList.remove('hidden');
}
function hideVortexRunningModal() {
  document.getElementById('vortexRunningModal').classList.add('hidden');
}
window.showVortexRunningModal = showVortexRunningModal;
window.hideVortexRunningModal = hideVortexRunningModal;
document.getElementById('vortexRunningCloseBtn').addEventListener('click', hideVortexRunningModal);
document.getElementById('vortexRunningRetryBtn').addEventListener('click', () => {
  hideVortexRunningModal();
  if (pendingVortexRunningRetry) pendingVortexRunningRetry();
});

// Startup-only "is your installed Vortex one this tool has actually been tested against" warning --
// decoupled from Apply Ignores' Preview flow (where this used to live) since it's a whole-app
// question, not specific to any one step. Runs on EVERY load, not just the default-landing routing
// branch further below (a deep link via ?area=/?reports= is still an app startup). Vortex running at
// startup, or the settings fetch itself failing, both just quietly skip -- re-checked next launch,
// never blocks the page over this.
function showVortexVersionWarning(vortexVersion) {
  const text = document.getElementById('vortexVersionWarningText');
  text.textContent = vortexVersion
    ? `This tool has been tested against Vortex 2.3.0-beta.1 and 2.3.0 -- you're running Vortex ${vortexVersion}.`
    : 'This tool has been tested against Vortex 2.3.0-beta.1 and 2.3.0 -- your installed version could not be detected.';
  document.getElementById('vortexVersionWarningModal').classList.remove('hidden');
}
document.getElementById('vortexVersionWarningCloseBtn').addEventListener('click', () => {
  document.getElementById('vortexVersionWarningModal').classList.add('hidden');
  if (document.getElementById('vortexVersionWarningDontShowInput').checked) {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hideVortexVersionWarning: true }),
    }).catch(() => {});
  }
});
fetch('/api/settings')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.hideVortexVersionWarning) return;
    return fetch('/api/sync/vortex-version-check')
      .then((r) => r.json())
      .then((check) => {
        if (check.vortexRunning || check.versionTested) return;
        showVortexVersionWarning(check.vortexVersion);
      });
  })
  .catch(() => {});

const AREA_LABELS = { rebuild: 'Rebuild Collection', sync: 'Update Collection', settings: 'Settings', reports: 'Reports' };

function showToolArea(id) {
  currentArea = id;
  for (const a of TOOL_AREAS) {
    document.getElementById(`area-${a}`).classList.toggle('hidden', a !== id);
    document.getElementById(`nav-${a}`).classList.toggle('nav-tab--active', a === id);
  }
  setPageLabel(AREA_LABELS[id] || '');
}

// Resolves 'save' or 'discard' -- shown only when navigating away from Settings with unsaved
// changes (window.settingsIsDirty/window.settingsSave, the deliberate seam settings-app.js exposes
// for exactly this; shell.js otherwise knows nothing about that file's internals). Both buttons
// navigate to the chosen destination -- there's no third "stay here" option, matching the exact
// two-button design requested (Save-then-go vs. discard-and-go).
function showUnsavedChangesModal() {
  const modal = document.getElementById('unsavedChangesModal');
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    document.getElementById('unsavedChangesDiscardBtn').onclick = () => { modal.classList.add('hidden'); resolve('discard'); };
    document.getElementById('unsavedChangesSaveBtn').onclick = () => { modal.classList.add('hidden'); resolve('save'); };
  });
}

for (const a of TOOL_AREAS) {
  document.getElementById(`nav-${a}`).addEventListener('click', async () => {
    if (currentArea === 'settings' && a !== 'settings' && window.settingsIsDirty && window.settingsIsDirty()) {
      const choice = await showUnsavedChangesModal();
      if (choice === 'save') {
        const ok = await window.settingsSave();
        if (!ok) return; // save failed -- stay on Settings so the error is visible and can be retried
      }
    }
    showToolArea(a);
  });
}

// Maps the URL's own ?reports= spelling to stats-app.js's internal sub-tab id (REPORTS_SUB_TABS) --
// 'work-through' (hyphenated, readable in a URL) becomes 'workthrough' (no separator, matching this
// project's own div-id/element-id convention throughout); 'updatecompare' already matches as-is.
// Anything else (including no param at all) falls back to 'stats', the default sub-tab.
const REPORTS_SUB_TAB_URL_MAP = { 'work-through': 'workthrough', updatecompare: 'updatecompare' };

// Lets any OTHER page (the standalone log-view page's own header nav, in particular) link straight
// into a specific area/sub-tab via ?area=rebuild|sync|settings|reports or
// ?reports=work-through|updatecompare|stats -- same mechanism as the "Back to Reports" case below,
// just generalized to all four areas instead of Reports only. showToolArea/showReportsSubTab calls
// are deferred to DOMContentLoaded:
// showReportsSubTab is defined in stats-app.js, loaded AFTER this file -- calling it here directly
// (synchronously, at this script's own top-level execution time) was confirmed live to silently
// no-op, since that script's <script> tag hasn't run yet at this point (the tab area switched with
// no data ever loaded -- Stats Report showed blank until manually clicking another sub-tab and
// back). DOMContentLoaded fires only once EVERY <script> tag on the page has finished executing --
// unlike the fetch().then() callback further below, which really is naturally async and was never
// affected by this.
const params = new URLSearchParams(location.search);
const reportsSubTab = params.get('reports');
const jumpArea = params.get('area');
if (reportsSubTab) {
  document.addEventListener('DOMContentLoaded', () => {
    showToolArea('reports');
    showReportsSubTab(REPORTS_SUB_TAB_URL_MAP[reportsSubTab] || 'stats');
  });
} else if (jumpArea && TOOL_AREAS.includes(jumpArea)) {
  document.addEventListener('DOMContentLoaded', () => showToolArea(jumpArea));
} else {
  // First-run check: land on Settings automatically when staging/downloads aren't configured yet,
  // with a banner explaining why -- this can only ever fire before the very first setup, since it
  // never triggers again once those two paths are saved. Falls back to the normal default (Rebuild
  // Collection) if this check itself fails for any reason, rather than getting stuck on a blank load.
  fetch('/api/settings')
    .then((r) => r.json())
    .then((cfg) => {
      if (!cfg.staging || !cfg.downloads) {
        const banner = document.getElementById('settingsFirstRunBanner');
        if (banner) banner.classList.remove('hidden');
        showToolArea('settings');
      } else {
        showToolArea('rebuild');
      }
    })
    .catch(() => showToolArea('rebuild'));
}
