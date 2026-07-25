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

// Lets any OTHER page (the standalone log-view page's own header nav, in particular) link straight
// into a specific area/sub-tab via ?area=rebuild|sync|settings|reports or ?reports=work-through|
// stats -- same mechanism as the "Back to Reports" case below, just generalized to all four areas
// instead of Reports only. showToolArea/showReportsSubTab calls are deferred to DOMContentLoaded:
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
    showReportsSubTab(reportsSubTab === 'work-through' ? 'workthrough' : 'stats');
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
