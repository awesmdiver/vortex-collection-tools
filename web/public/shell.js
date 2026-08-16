'use strict';
// Minimal top-level nav shared by every tool area in this project -- deliberately dumb (a flat
// list of registered areas) so adding a future 3rd/4th Vortex tool area later is "register one
// more entry", not a redesign. Each area is a plain <section class="tool-area"> already present in
// index.html; this only toggles which one is visible. app.js and sync-app.js each own their own
// internal view-state exactly as before -- this file knows nothing about either.

const TOOL_AREAS = ['home', 'rebuild', 'sync', 'settings', 'reports', 'rules-generator', 'utilities', 'merge'];
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
let lastPageLabel = '';
function setPageLabel(label) {
  lastPageLabel = label;
  const el = document.getElementById('headerMeta');
  if (el) el.textContent = label;
  // appName is theme data (theme.js/DESIGN.md's "Brand theming framework") -- read live off
  // window.activeTheme rather than baked in here, so re-theming updates the tab title too. Falls
  // back to today's literal name until the theme fetch resolves (or if it never does).
  const appName = (window.activeTheme && window.activeTheme.appName) || 'Vortex Collection Tools';
  document.title = label ? `${appName} — ${label}` : appName;
}
window.setPageLabel = setPageLabel;
// Lets theme.js re-derive document.title once the theme finishes loading, using whatever page
// label is currently showing (it has no way to know that itself).
window.refreshPageTitle = () => setPageLabel(lastPageLabel);

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
    ? `This tool has been tested through Vortex 2.5.0 -- you're running Vortex ${vortexVersion}.`
    : "This tool has been tested through Vortex 2.5.0 -- your installed version could not be detected.";
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

const AREA_LABELS = { home: 'Home', rebuild: 'Rebuild Collection', sync: 'Update Collection', settings: 'Settings', reports: 'Reports', 'rules-generator': 'Rules Generator', utilities: 'Utilities', merge: 'Merge Plugins' };

function showToolArea(id) {
  currentArea = id;
  for (const a of TOOL_AREAS) {
    document.getElementById(`area-${a}`).classList.toggle('hidden', a !== id);
    // Home replaced the old five-tab .app-nav -- only Settings still has a real nav-* element
    // (the gear button), so every other area's lookup here is expected to come back null now.
    const navBtn = document.getElementById(`nav-${a}`);
    if (navBtn) navBtn.classList.toggle('nav-tab--active', a === id);
  }
  setPageLabel(AREA_LABELS[id] || '');
  // Every area shares the same page-level scroll (no per-area scroll container -- see styles.css),
  // so switching areas otherwise leaves you at whatever scrollY the PREVIOUS area was at instead of
  // landing at the top of the new one. Confirmed live 2026-07-27: clicking the Settings nav icon
  // while scrolled partway down another page dropped you mid-Settings instead of at its top.
  window.scrollTo(0, 0);

  // Keep the URL in sync with client-side navigation -- confirmed real gap 2026-07-27: this function
  // never touched the URL before, so clicking between nav tabs left the address bar (and thus any
  // browser refresh) pointing at whatever ?area= the page happened to first load with -- e.g. a
  // refresh always landing back on Update Collection just because that was the last DEEP LINK ever
  // visited, regardless of which tab was actually showing. history.replaceState (not pushState) --
  // this should update the CURRENT entry, not pile up a new Back-button stop for every tab click.
  // ?reports=/?utilities= are cleared here when navigating to a DIFFERENT area; showReportsSubTab/
  // showUtilitiesSubTab set their own right back afterward, when id IS that area (both of those run
  // via their own listener on the same nav-tab click, immediately after this one).
  const url = new URL(location.href);
  url.searchParams.set('area', id);
  if (id !== 'reports') url.searchParams.delete('reports');
  if (id !== 'utilities') url.searchParams.delete('utilities');
  history.replaceState(null, '', url);
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

// The single entry point for every LIVE (already-loaded-page) navigation -- home cards, the
// header logo/title, and the Settings gear button all funnel through this, replacing the old
// per-nav-tab loop that used to wire all six areas (only Settings still has a real nav-* element
// since Home replaced the rest). Reproduces the same per-area "just arrived" side effects the
// deep-link (?area=) branch further below already does on page load: Update Collection needs its
// profile dropdown loaded, Reports/Utilities cards land on a specific sub-tab rather than whatever
// was last shown.
async function navigateToArea(id, subTab) {
  if (currentArea === 'settings' && id !== 'settings' && window.settingsIsDirty && window.settingsIsDirty()) {
    const choice = await showUnsavedChangesModal();
    if (choice === 'save') {
      const ok = await window.settingsSave();
      if (!ok) return; // save failed -- stay on Settings so the error is visible and can be retried
    }
  }
  showToolArea(id);
  if (id === 'sync' && window.loadSyncProfiles) window.loadSyncProfiles();
  if (id === 'reports' && subTab && window.showReportsSubTab) window.showReportsSubTab(subTab);
  if (id === 'utilities' && subTab && window.showUtilitiesSubTab) window.showUtilitiesSubTab(subTab);
  // Same "load Vortex-gated data only when this area is actually visited" fix as the 'sync' case
  // above (queue: rules-generator-eager-load-collision) -- rules-generator-app.js used to call this
  // unconditionally on every page load regardless of the active area, which could pop the shared
  // Vortex-running modal on a totally unrelated page and silently steal any OTHER page's own retry.
  if (id === 'rules-generator' && window.rgLoadPickers) window.rgLoadPickers();
}
window.navigateToArea = navigateToArea;

document.getElementById('appHeaderTitle').addEventListener('click', () => navigateToArea('home'));
document.getElementById('nav-settings').addEventListener('click', () => navigateToArea('settings'));

// Tool page breadcrumb eyebrow's "Home" link (DESIGN.md's "Tool page breadcrumb" section) -- one
// delegated listener covers every .tool-eyebrow__home across every tool page's own tool-hero,
// same destination as the header logo/title. preventDefault since these are real <a href="#">
// elements (matching design/vortex-tool-eyebrow-mockup.html) purely for their link-like appearance,
// not real navigation.
document.addEventListener('click', (e) => {
  const home = e.target.closest('.tool-eyebrow__home');
  if (home) {
    e.preventDefault();
    navigateToArea('home');
  }
});

// Pinning (DESIGN.md's "Pinning" section) -- a star per Home card. Pinning MOVES a card's own real
// DOM node into a dedicated Pinned row above the category sections -- it does NOT duplicate it
// (confirmed 2026-07-28: the earlier additive/clone version read as clutter). A section that loses
// every one of its cards to pinning hides entirely. Persisted to localStorage (same mechanism as
// the theme preference above) -- purely a personal display preference, no server round-trip needed.
const PINNED_TOOLS_STORAGE_KEY = 'pinnedTools';
function loadPinnedTools() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_TOOLS_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}
const pinnedTools = loadPinnedTools();
function savePinnedTools() {
  localStorage.setItem(PINNED_TOOLS_STORAGE_KEY, JSON.stringify(Array.from(pinnedTools)));
}

function setStarVisual(star, on) {
  star.classList.toggle('on', on);
  star.textContent = on ? '★' : '☆';
  star.title = on ? 'Unpin' : 'Pin to top';
}

// The one fixed order every grid (a section's own, or the Pinned row's) is kept in -- pinning/
// unpinning only ever LIFTS a card out or drops it back in; it never reorders whichever cards stay
// put. Reused for both directions (into Pinned, back into a section) since a section's own order is
// already just a sub-sequence of this same list.
const HOME_CANONICAL_ORDER = [
  'merge', 'rebuild', 'sync', 'rules-generator',
  'stats', 'workthrough', 'updatecompare', 'rulesgen', 'workshopreport',
  'missingmasters', 'scrub', 'archivefinder', 'missingfiles',
];
function pinKeyOf(wrap) {
  return wrap.querySelector('.home-card__star').dataset.pinKey;
}
function insertInCanonicalOrder(grid, wrap) {
  const myIndex = HOME_CANONICAL_ORDER.indexOf(pinKeyOf(wrap));
  const nextSibling = Array.from(grid.children).find(
    (sib) => HOME_CANONICAL_ORDER.indexOf(pinKeyOf(sib)) > myIndex
  );
  // appendChild/insertBefore on a node already in the document MOVES it -- this is what actually
  // makes pinning "move, not duplicate": no cloneNode, no re-wiring, the exact same node (and its
  // listeners) just changes parent.
  if (nextSibling) grid.insertBefore(wrap, nextSibling);
  else grid.appendChild(wrap);
}

function pinnedRowGrid() {
  return document.querySelector('#homePinnedRow .home-grid');
}
// Creates the "📌 Pinned" title + grid the first time something gets pinned; returns the (possibly
// just-created) grid to insert into.
function ensurePinnedRowGrid() {
  let grid = pinnedRowGrid();
  if (grid) return grid;
  const row = document.getElementById('homePinnedRow');
  const title = document.createElement('div');
  title.className = 'home-section-title';
  title.textContent = '📌 Pinned';
  grid = document.createElement('div');
  grid.className = 'home-grid';
  row.appendChild(title);
  row.appendChild(grid);
  return grid;
}
// Tears the Pinned row back down to nothing once the last pinned card leaves it -- keeps "hide the
// Pinned zone entirely when nothing is pinned" true without a leftover empty title+grid in the DOM.
function clearPinnedRowIfEmpty() {
  const grid = pinnedRowGrid();
  if (grid && grid.children.length === 0) document.getElementById('homePinnedRow').innerHTML = '';
}

function homeSectionElFor(wrap) {
  return document.getElementById(wrap.dataset.section);
}
// A section hides entirely once every one of its cards has been pinned away, and un-hides the
// moment any card returns to it -- checked fresh off the grid's own child count each time, not a
// separately-tracked counter that could drift.
function refreshSectionVisibility(sectionEl) {
  const grid = sectionEl.querySelector('.home-grid');
  sectionEl.classList.toggle('hidden', grid.children.length === 0);
}

// Moves ONE card to reflect `pinned` -- used both for a live star click and for applying persisted
// pins at load. Touches only the Pinned row and the one section this card belongs to, never any
// other section and never the whole page (DESIGN.md's explicit no-flicker rule).
function applyPinState(key, pinned) {
  const star = document.querySelector(`.home-card__star[data-pin-key="${CSS.escape(key)}"]`);
  if (!star) return;
  const wrap = star.closest('.home-card-wrap');
  const sectionEl = homeSectionElFor(wrap);
  setStarVisual(star, pinned);
  if (pinned) {
    insertInCanonicalOrder(ensurePinnedRowGrid(), wrap);
  } else {
    insertInCanonicalOrder(sectionEl.querySelector('.home-grid'), wrap);
  }
  refreshSectionVisibility(sectionEl);
  clearPinnedRowIfEmpty();
}

function toggleFavTool(key) {
  const pinning = !pinnedTools.has(key);
  if (pinning) pinnedTools.add(key); else pinnedTools.delete(key);
  savePinnedTools();
  applyPinState(key, pinning);
}

// Each real card only ever needs wiring ONCE, here at load -- pinning now MOVES this same node
// around rather than cloning it, so there's never a second copy that would need its own listeners.
document.querySelectorAll('#homeCategorySections .home-card-wrap').forEach((wrap) => {
  const card = wrap.querySelector('.home-card');
  const star = wrap.querySelector('.home-card__star');
  card.addEventListener('click', () => navigateToArea(card.dataset.area, card.dataset.sub));
  star.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the card's own navigate-away click underneath it
    toggleFavTool(star.dataset.pinKey);
  });
});
// Apply any pins already persisted from a previous visit -- moves each one into the Pinned row and
// hides its section if that empties it out, all before the very first paint.
for (const key of pinnedTools) applyPinState(key, true);

// Maps the URL's own ?reports= spelling to stats-app.js's internal sub-tab id (REPORTS_SUB_TABS) --
// 'work-through' (hyphenated, readable in a URL) becomes 'workthrough' (no separator, matching this
// project's own div-id/element-id convention throughout); every other id already matches its
// internal id as-is, so it's listed here identity-mapped rather than omitted -- omitting an id
// silently falls through to the 'stats' default below, which is exactly the bug found live
// 2026-08-15 (queue: rebuild-missing-hand-pick-exceptions verification): 'rulesgen' was ALSO
// missing from this map already, pre-existing and unrelated to that feature, caught incidentally
// while confirming a direct-URL-reload lands on the right sub-tab for the new 'exceptions' entry.
const REPORTS_SUB_TAB_URL_MAP = { 'work-through': 'workthrough', updatecompare: 'updatecompare', workshop: 'workshop', rulesgen: 'rulesgen', exceptions: 'exceptions' };

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
  document.addEventListener('DOMContentLoaded', () => {
    showToolArea(jumpArea);
    // Update Collection's own profile data needs a live Vortex-state check (vortexRunningGate) --
    // never fire it for any other area, and never unconditionally at load (see sync-app.js's boot()
    // for the full reasoning: that used to run on every page load regardless of the active area,
    // popping the shared Vortex-running modal on totally unrelated pages). window.loadSyncProfiles
    // is defined by sync-app.js, which loads BEFORE this DOMContentLoaded callback ever fires (same
    // "call a later-loaded script's function" technique already used for showReportsSubTab above).
    // Skipped when a real profileId is already in the URL -- that's the Ignored/Disabled report's
    // own Back link, and sync-app.js's boot() already awaits loadSyncProfiles() itself in that exact
    // case, so calling it again here would just be a redundant, wasteful second fetch.
    if (jumpArea === 'sync' && !params.get('profileId')) window.loadSyncProfiles?.();
    // Restores the Utilities sub-tab (Missing Masters/Vortex Scrub) the same way the ?reports=
    // branch above restores a Reports sub-tab -- showUtilitiesSubTab is defined in cleanup-app.js,
    // which also loads before this callback ever fires, same deferred-to-DOMContentLoaded technique.
    if (jumpArea === 'utilities') {
      const utilitiesSubTab = params.get('utilities');
      if (utilitiesSubTab) window.showUtilitiesSubTab?.(utilitiesSubTab);
    }
    // Same reasoning as the 'sync' case above -- a direct "?area=rules-generator" link/refresh needs
    // this too, not just the live-navigation path through navigateToArea.
    if (jumpArea === 'rules-generator') window.rgLoadPickers?.();
  });
} else {
  // First-run check: land on Settings automatically when staging/downloads aren't configured yet,
  // with a banner explaining why -- this can only ever fire before the very first setup, since it
  // never triggers again once those two paths are saved. Falls back to the normal default (Home)
  // if this check itself fails for any reason, rather than getting stuck on a blank load.
  fetch('/api/settings')
    .then((r) => r.json())
    .then((cfg) => {
      if (!cfg.staging || !cfg.downloads) {
        const banner = document.getElementById('settingsFirstRunBanner');
        if (banner) banner.classList.remove('hidden');
        const premiumBanner = document.getElementById('settingsFirstRunPremiumBanner');
        if (premiumBanner) premiumBanner.classList.remove('hidden');
        showToolArea('settings');
      } else {
        showToolArea('home');
      }
    })
    .catch(() => showToolArea('home'));
}
