'use strict';
// Minimal top-level nav shared by every tool area in this project -- deliberately dumb (a flat
// list of registered areas) so adding a future 3rd/4th Vortex tool area later is "register one
// more entry", not a redesign. Each area is a plain <section class="tool-area"> already present in
// index.html; this only toggles which one is visible. app.js and sync-app.js each own their own
// internal view-state exactly as before -- this file knows nothing about either.

const TOOL_AREAS = ['rebuild', 'sync'];

function showToolArea(id) {
  for (const a of TOOL_AREAS) {
    document.getElementById(`area-${a}`).classList.toggle('hidden', a !== id);
    document.getElementById(`nav-${a}`).classList.toggle('nav-tab--active', a === id);
  }
}

for (const a of TOOL_AREAS) {
  document.getElementById(`nav-${a}`).addEventListener('click', () => showToolArea(a));
}

showToolArea('rebuild');
