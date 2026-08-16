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
  // ?theme=<id> is a temporary preview override, NOT a real picker (that's still deferred, see
  // DESIGN.md) -- lets a theme be eyeballed via a plain URL during Phase 2 review without needing
  // devtools. Doesn't persist to localStorage; a normal reload without the param goes back to
  // whatever's actually saved.
  const urlTheme = new URLSearchParams(location.search).get('theme');
  const THEME_ID = urlTheme || localStorage.getItem('vct-theme') || 'plain';

  // Small lookup helper for the page-label maps in app.js/shell.js/stats-app.js (AREA_LABELS,
  // VIEW_LABELS, REPORTS_SUB_TAB_LABELS) -- those build the browser-tab title and the visible
  // #headerMeta text in the header, entirely separately from the data-tool-id/data-brand-slot
  // markup this file otherwise drives, so they need their own theme-aware lookup. Falls back to
  // whatever English label the caller already had if the theme hasn't loaded yet or has no entry
  // for this id (e.g. group ids like "reports"/"utilities" that aren't a real stable tool id).
  window.themedToolName = function (id, fallback) {
    const t = window.activeTheme && window.activeTheme.tools && window.activeTheme.tools[id];
    return (t && t.name) || fallback;
  };

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

  // styles.css already treats brand accent as appearance-aware in disguise: :root (dark, the
  // default) and :root[data-theme="light"]/the light media query each hardcode their OWN
  // --accent/--accent-hover/--accent-bg trio (a bluer, higher-contrast pair for light backgrounds).
  // A single inline document.documentElement.style.setProperty('--accent', ...) can't express "only
  // in light mode" -- it wins over BOTH cascade branches unconditionally (inline style beats any
  // selector), which would silently pin light mode to the dark-mode hex. Confirmed live: before this
  // fix, loading in light mode showed #5b8def (the dark blue) instead of the correct #3568c9 --
  // Phase 1's own "byte-for-byte identical" claim was never checked in light mode and quietly broke
  // it. Fixed by injecting a real <style> block that mirrors styles.css's own two-branch structure
  // instead of setting one flat inline value -- real CSS selectors, so it also keeps working
  // automatically if the user toggles Appearance afterwards (settings-app.js just flips
  // data-theme), no toggle-listener needed here.
  //
  // --accent-hover/--accent-bg: derived from whichever accent is active per branch UNLESS the theme
  // supplies its own explicit accentHover/accentBg (Plain does, matching its exact pre-Phase-1 hex
  // values so Plain stays truly byte-identical in both modes -- the derivation below is a reasonable
  // first-pass approximation for a brand-new theme like Skyrim, not a guarantee of pixel fidelity).
  function deriveAccentShades(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lighten = (c) => Math.round(c + (255 - c) * 0.28);
    const hoverHex = '#' + [lighten(r), lighten(g), lighten(b)]
      .map((c) => c.toString(16).padStart(2, '0')).join('');
    return { hover: hoverHex, bg: `rgba(${r}, ${g}, ${b}, 0.12)` };
  }

  function accentBlock(accent, hoverOverride, bgOverride) {
    if (!accent) return '';
    const derived = deriveAccentShades(accent) || {};
    const hover = hoverOverride || derived.hover || accent;
    const bg = bgOverride || derived.bg || 'transparent';
    return `--accent: ${accent}; --accent-hover: ${hover}; --accent-bg: ${bg};`;
  }

  function applyAccentStylesheet(theme) {
    if (!theme.accent) return;
    const darkCss = accentBlock(theme.accent, theme.accentHover, theme.accentBg);
    // accentLight/accentHoverLight/accentBgLight are optional -- a theme that doesn't bother with a
    // light-mode variant just uses the same accent everywhere, a legitimate choice for a first-pass
    // brand-new theme (nothing to be "faithful" to yet, unlike Plain).
    const lightCss = accentBlock(
      theme.accentLight || theme.accent,
      theme.accentHoverLight || theme.accentHover,
      theme.accentBgLight || theme.accentBg
    );

    const css = `
      :root { ${darkCss} }
      @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${lightCss} } }
      :root[data-theme="light"] { ${lightCss} }
    `;

    let styleEl = document.getElementById('theme-accent-overrides');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'theme-accent-overrides';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  function applyTheme(theme) {
    applyAccentStylesheet(theme);

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

      applyBannerImage(container, t.bannerImage);
    });

    // Section-GROUP banners (Home's "Main tools"/"Reports"/"Utilities" dividers) are a DIFFERENT
    // concept from a stable tool id -- a group has no tool of its own, no routing, nothing in
    // data-area/data-sub. Kept as its own theme.sections map (id: "mainTools"/"reports"/"utilities",
    // matching each .home-section's own data-section-id) rather than overloading theme.tools, since
    // DESIGN.md is explicit that stable tool IDs are a permanent code/theme join -- a section group
    // isn't one and shouldn't be treated like one.
    document.querySelectorAll('[data-section-id]').forEach((container) => {
      const id = container.getAttribute('data-section-id');
      const s = theme.sections && theme.sections[id];
      if (!s) return;
      const nameEl = container.querySelector('[data-brand-slot="name"]');
      if (nameEl && s.name != null) nameEl.textContent = s.name;
      applyBannerImage(container, s.bannerImage);
    });
  }

  // Shared by both the per-tool and per-section passes above -- an entry with no bannerImage (Plain
  // never has one) leaves the <img> exactly as it started (.hidden, no src), so nothing renders and
  // no failed-request console noise appears either.
  function applyBannerImage(container, bannerImage) {
    const bannerEl = container.querySelector('[data-brand-slot="bannerImage"]');
    if (!bannerEl) return;
    if (bannerImage) {
      bannerEl.src = bannerImage;
      bannerEl.classList.remove('hidden');
    } else {
      bannerEl.classList.add('hidden');
      bannerEl.removeAttribute('src');
    }
  }
})();
