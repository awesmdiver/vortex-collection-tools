'use strict';
// "More from me" section at the bottom of Settings (director-approved mockup, Option A cards,
// 2026-10-01): the director's three tools plus tip links. The tool list and links live in ONE data
// structure (MORE_FROM_ME_TOOLS) so adding a fourth tool is a one-place change. A tool with no `url`
// renders its card without a link. `linkLabel` is the link's words (none: "GitHub"); the two
// SkyrimNet tools link to their plugins page so the author gets the credit there.
//
// Dual-context like status-labels.js: a plain classic <script> in the browser (page globals) AND a
// require()-able CommonJS module in Node (scripts/test-more-from-me.js). Rendering is a pure
// string-builder so the test needs no DOM.

const MORE_FROM_ME_HEADING = 'I make QOL mods to make things easier.';
const MORE_FROM_ME_LEAD = "Free tools for a smoother modded Skyrim. Here's the set.";

const MORE_FROM_ME_TOOLS = [
  {
    id: 'vortex-collection-tools',
    name: 'Vortex Collection Tools',
    description: 'Everything you need to run massive Vortex collections without the friction.',
    url: 'https://github.com/awesmdiver/vortex-collection-tools',
    isThisTool: true,
  },
  {
    id: 'skyrimnet-multiproxy',
    name: 'SkyrimNet MultiProxy',
    description: 'Cloud or Local. Paid or Free. Any AI, Straight to SkyrimNet.',
    url: 'https://fateless.ai/plugins/awesmdiver/skyrimnet-multiproxy',
    linkLabel: 'Plugins page',
  },
  {
    id: 'modpacer',
    name: 'ModPacer',
    description: 'Easily install new mods and keep them on pace with updates.',
    url: 'https://fateless.ai/plugins/awesmdiver/modpacer',
    linkLabel: 'Plugins page',
  },
];

const MORE_FROM_ME_TIP_BOLD = 'Enjoying these?';
const MORE_FROM_ME_TIP_TEXT = "A tip keeps the coffee flowing.";
const MORE_FROM_ME_TIP_LINKS = [
  { id: 'paypal', label: 'PayPal', url: 'https://paypal.me/awesmdiver', color: '#00457C' },
  { id: 'venmo', label: 'Venmo', url: 'https://www.venmo.com/u/awesmdiver', color: '#3D95CE' },
];

function moreFromMeEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function moreFromMeHtml() {
  const cards = MORE_FROM_ME_TOOLS.map((t) => {
    const link = t.url
      ? `<a class="more-from-me__link" href="${moreFromMeEsc(t.url)}" target="_blank" rel="noopener noreferrer">${moreFromMeEsc(t.linkLabel || 'GitHub')} ↗</a>`
      : '';
    const here = t.isThisTool ? '<span class="more-from-me__here">You\'re here</span>' : '';
    return `<div class="more-from-me__card${t.isThisTool ? ' more-from-me__card--here' : ''}" data-tool="${moreFromMeEsc(t.id)}">`
      + `<div class="more-from-me__name">${moreFromMeEsc(t.name)}</div>`
      + `<div class="more-from-me__desc">${moreFromMeEsc(t.description)}</div>`
      + `<div class="more-from-me__foot">${link}${here}</div></div>`;
  }).join('');
  const tips = MORE_FROM_ME_TIP_LINKS.map((t) =>
    `<a class="btn more-from-me__tip" data-tip="${moreFromMeEsc(t.id)}" href="${moreFromMeEsc(t.url)}" target="_blank" rel="noopener noreferrer" style="background:${t.color};border-color:${t.color};color:#fff">${moreFromMeEsc(t.label)}</a>`
  ).join('');
  return `<div class="settings-group more-from-me">`
    + `<h2 class="more-from-me__title">${moreFromMeEsc(MORE_FROM_ME_HEADING)}</h2>`
    + `<p class="muted more-from-me__lead">${moreFromMeEsc(MORE_FROM_ME_LEAD)}</p>`
    + `<div class="more-from-me__cards">${cards}</div>`
    + `<div class="more-from-me__support"><div class="more-from-me__support-text"><strong>${moreFromMeEsc(MORE_FROM_ME_TIP_BOLD)}</strong> `
    + `<span class="muted">${moreFromMeEsc(MORE_FROM_ME_TIP_TEXT)}</span></div>${tips}</div></div>`;
}

function renderMoreFromMe() {
  const mount = document.getElementById('moreFromMe');
  if (!mount) return;
  mount.innerHTML = moreFromMeHtml();
  // Separate-window pattern from DESIGN.md "External links open in a separate window": the href +
  // target stay as the middle-click/ctrl-click fallback; a plain click opens a real popup window.
  mount.querySelectorAll('a[href]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener,width=1200,height=900');
    });
  });
}

if (typeof document !== 'undefined') renderMoreFromMe();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MORE_FROM_ME_HEADING, MORE_FROM_ME_LEAD, MORE_FROM_ME_TOOLS,
    MORE_FROM_ME_TIP_BOLD, MORE_FROM_ME_TIP_TEXT, MORE_FROM_ME_TIP_LINKS, moreFromMeHtml,
  };
}
