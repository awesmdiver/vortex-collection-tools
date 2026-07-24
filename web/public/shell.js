'use strict';
// Minimal top-level nav shared by every tool area in this project -- deliberately dumb (a flat
// list of registered areas) so adding a future 3rd/4th Vortex tool area later is "register one
// more entry", not a redesign. Each area is a plain <section class="tool-area"> already present in
// index.html; this only toggles which one is visible. app.js and sync-app.js each own their own
// internal view-state exactly as before -- this file knows nothing about either.

const TOOL_AREAS = ['rebuild', 'sync', 'settings'];

function showToolArea(id) {
  for (const a of TOOL_AREAS) {
    document.getElementById(`area-${a}`).classList.toggle('hidden', a !== id);
    document.getElementById(`nav-${a}`).classList.toggle('nav-tab--active', a === id);
  }
}

for (const a of TOOL_AREAS) {
  document.getElementById(`nav-${a}`).addEventListener('click', () => showToolArea(a));
}

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
