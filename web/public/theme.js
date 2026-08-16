'use strict';
// Brand theming runtime (DESIGN.md's "Brand theming framework" section, Phase 1). The current
// index.html markup already carries today's Plain-theme strings hardcoded, on purpose: this is a
// same-origin static JSON fetch on localhost (effectively instant), so rather than blank the DOM or
// show a spinner while it resolves, we leave the hardcoded text in place as the fallback and simply
// OVERWRITE it once the theme loads. That way there's no flash-of-empty-content to design around,
// and if the fetch ever fails, the page still reads exactly as it always has.
//
// Every element a theme can brand is tagged in index.html with data-brand-slot ("name", "emoji",
// "function", "heroTitle", "heroBody", "cardDesc", "appName"), and every home-card / tool-hero
// container that groups those slots also carries data-tool-id="<stable id>" so this file knows which
// theme.tools[id] entry to pull from. Nothing here decides WHAT a tool is or does -- only what it's
// called and how it reads, exactly per the golden rule in DESIGN.md.

(function () {
  const THEME_ID = localStorage.getItem('vct-theme') || 'plain';

  fetch(`/themes/${THEME_ID}.json`)
    .then((r) => r.json())
    .then((theme) => {
      window.activeTheme = theme;
      applyTheme(theme);
    })
    .catch(() => {
      // Fetch/parse failed -- leave the hardcoded Plain strings already in the HTML exactly as they
      // are. Nothing to recover from; the page is still fully correct, just not theme-driven yet.
    });

  function applyTheme(theme) {
    if (theme.accent) {
      document.documentElement.style.setProperty('--accent', theme.accent);
    }

    if (theme.appName) {
      const appNameEl = document.querySelector('[data-brand-slot="appName"]');
      if (appNameEl) appNameEl.textContent = theme.appName;
      // The header title's own text node just changed -- re-derive document.title (and the
      // #headerMeta label) through shell.js's setPageLabel so the app-name half of the title bar
      // picks up the new value too, using whatever page label is currently showing.
      if (window.refreshPageTitle) window.refreshPageTitle();
    }

    // Every brand-carrying container (.home-card, .tool-hero) is tagged data-tool-id="<stable id>".
    // Walk each one once and fill in whichever data-brand-slot children it actually has -- Home's
    // own tool-hero has no cardDesc slot, Settings has no home-card at all, etc.
    document.querySelectorAll('[data-tool-id]').forEach((container) => {
      const id = container.getAttribute('data-tool-id');
      const t = theme.tools && theme.tools[id];
      if (!t) return;

      const emojiEl = container.querySelector('[data-brand-slot="emoji"]');
      if (emojiEl && t.emoji != null) emojiEl.textContent = t.emoji;

      const nameEl = container.querySelector('[data-brand-slot="name"]');
      if (nameEl && t.name != null) nameEl.textContent = t.name;

      const cardDescEl = container.querySelector('[data-brand-slot="cardDesc"]');
      if (cardDescEl && t.cardDesc != null) cardDescEl.innerHTML = t.cardDesc;

      // heroTitle: the emoji and title text live combined in one text node today
      // (e.g. "⚡ Rebuild Collections in Minutes, Not Hours") and no CSS depends on them being
      // separate child nodes, so the simplest faithful reproduction is to set them combined here too
      // rather than splitting tool-hero__title into child spans.
      const heroTitleEl = container.querySelector('[data-brand-slot="heroTitle"]');
      if (heroTitleEl && t.heroTitle != null) {
        heroTitleEl.textContent = t.emoji ? `${t.emoji} ${t.heroTitle}` : t.heroTitle;
      }

      // heroBody/cardDesc can carry inline HTML (e.g. Update Collection's <strong> tags, &mdash;
      // entities) in the source copy, so these are set via innerHTML, not textContent.
      const heroBodyEl = container.querySelector('[data-brand-slot="heroBody"]');
      if (heroBodyEl && t.heroBody != null) heroBodyEl.innerHTML = t.heroBody;
    });
  }
})();
