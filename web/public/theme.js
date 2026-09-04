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
  // ?theme=<id> overrides everything below for a one-off preview link (doesn't persist to
  // localStorage; a normal reload without the param goes back to whatever's actually saved). The
  // REAL picker lives in Settings > Style (settings-app.js's settingsBrandThemeSelect), same
  // 'vct-theme' localStorage key. Default is 'skyrim', not 'plain' -- director's own call
  // (2026-08-15): Skyrim is the default experience for a fresh install now; "Standard (no theme)"
  // in the picker is the explicit opt-out for someone who wants the original, unthemed app.
  const urlTheme = new URLSearchParams(location.search).get('theme');
  const THEME_ID = urlTheme || localStorage.getItem('vct-theme') || 'skyrim';

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

  // Home-card standard-name tooltip (2026-08-25) -- how long a hover has to hold before it shows.
  // Tune this one constant to change the feel app-wide; everything else derives from it.
  const HOME_CARD_TOOLTIP_DELAY_MS = 400;

  // One shared tooltip element for every home card (created lazily, reused) -- cheaper than one
  // per card, and there's only ever one visible at a time anyway (a mouseleave always fires before
  // the next card's mouseenter). Plain fixed-position div, not the native `title` attribute --
  // see applyTheme's own call site for why.
  let homeCardTooltipEl = null;
  let homeCardTooltipTimer = null;
  function showHomeCardTooltip(card, text) {
    if (!homeCardTooltipEl) {
      homeCardTooltipEl = document.createElement('div');
      homeCardTooltipEl.className = 'home-card-tooltip';
      document.body.appendChild(homeCardTooltipEl);
    }
    homeCardTooltipEl.textContent = text;
    const rect = card.getBoundingClientRect();
    homeCardTooltipEl.style.left = `${rect.left + rect.width / 2}px`;
    homeCardTooltipEl.style.top = `${rect.top}px`;
    homeCardTooltipEl.classList.add('visible');
  }
  function hideHomeCardTooltip() {
    clearTimeout(homeCardTooltipTimer);
    if (homeCardTooltipEl) homeCardTooltipEl.classList.remove('visible');
  }
  // aria-label carries the same info for screen readers immediately (no hover/delay involved) --
  // the custom tooltip below is a purely visual, mouse-hover affordance on top of that, not a
  // replacement for it.
  function wireHomeCardTooltip(card, text) {
    card.setAttribute('aria-label', text);
    card.addEventListener('mouseenter', () => {
      homeCardTooltipTimer = setTimeout(() => showHomeCardTooltip(card, text), HOME_CARD_TOOLTIP_DELAY_MS);
    });
    card.addEventListener('mouseleave', hideHomeCardTooltip);
    // A card is also a real navigation target -- clicking it should never leave a stale tooltip
    // lingering on whatever page loads next.
    card.addEventListener('click', hideHomeCardTooltip);
  }

  fetch(`/themes/${THEME_ID}.json`)
    .then((r) => r.json())
    .then((theme) => {
      window.activeTheme = theme;
      applyTheme(theme);
      // settings-app.js's own font sub-picker needs theme.fonts, but this fetch is async and script
      // tags run their own top-level code synchronously before it resolves -- window.activeTheme
      // isn't set yet at the point settings-app.js's own top-level code would otherwise try to read
      // it. Listen for this instead of assuming timing (settings-app.js checks window.activeTheme
      // directly too, in case this already fired before it started listening).
      window.dispatchEvent(new CustomEvent('themeready'));
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

  // Home-wash background-tint DEFAULT derivation (2026-08-27 fix) -- sibling to deriveAccentShades
  // above, not a rewrite of it: that function's lighten-toward-white math for --accent-hover is
  // untouched. This is a SEPARATE need -- a genuinely DARKER variant of the accent for the Home
  // background wash, which nothing in this file ever produced before (confirmed live: the picker's
  // own two swatches showed the identical accent hex with no override set, because the CSS fallback
  // chain (styles.css's `var(--bg-tint, var(--accent))`) resolves straight to accent with nothing
  // else in between).
  //
  // clamp/hexToHsl/hslToHex are plain color-math primitives, not brand-specific -- HSL is the right
  // space for "same hue, darker" (RGB has no direct lightness axis to move along).
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function hexToHsl(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1));
      if (max === r) h = 60 * (((g - b) / delta) % 6);
      else if (max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
      if (h < 0) h += 360;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  // Fallback formula, used ONLY for a genuinely CUSTOM accent (the color picker's own accent
  // override) -- the four themes that actually ship each carry a director-picked EXACT bg-tint hex
  // literally in their own theme JSON (theme.bgTint) instead; this function never runs for those.
  // Calibrated against the director's own real pairing (accent #5b8def -> bg-tint #0055ff: hue
  // unchanged ~220, lightness ~65%->~46%, saturation pushed toward 100%), but this only ever needs
  // to produce something reasonable for an arbitrary custom accent, not reproduce a specific target.
  function deriveDefaultBgTint(hex) {
    const hsl = hexToHsl(hex);
    if (!hsl) return null;
    const newSat = clamp(Math.max(hsl.s, 95), 95, 100);
    const newLightness = clamp(hsl.l - 19, 35, 50);
    return hslToHex(hsl.h, newSat, newLightness);
  }

  function accentBlock(accent, hoverOverride, bgOverride) {
    if (!accent) return '';
    const derived = deriveAccentShades(accent) || {};
    const hover = hoverOverride || derived.hover || accent;
    const bg = bgOverride || derived.bg || 'transparent';
    return `--accent: ${accent}; --accent-hover: ${hover}; --accent-bg: ${bg};`;
  }

  // Real color picker (Theming: color picker, 2026-08-15) -- a personal override layered ON TOP of
  // whichever Style is active, not a new saved "theme" of its own (director's own call: simpler
  // mental model than a 3rd concept competing with Style/Font for what "theme" even means). Own
  // localStorage key PER theme+color ('vct-color-accent-<themeId>', 'vct-color-bg-<themeId>'), same
  // per-theme-scoping reasoning the font picker already established -- switching Style later
  // shouldn't carry a custom color over to an unrelated theme. One color for both light/dark
  // Appearance modes (director's own call, #2 of 3 open questions from the mockup) -- Plain is the
  // one exception with real separate light/dark hex values, because Plain predates theming and its
  // whole point is staying byte-identical to what it always was; a personal override doesn't carry
  // that same fidelity requirement.
  function getColorOverride(themeId, key) {
    return localStorage.getItem(`vct-color-${key}-${themeId}`) || null;
  }
  window.getThemeColorOverride = getColorOverride;

  function applyAccentStylesheet(theme) {
    if (!theme.accent) return;
    const accentOverride = getColorOverride(theme.id, 'accent');
    // Overridden: the SAME custom color for both modes (see fn comment above) -- skip theme's own
    // accentLight/accentHoverLight/accentBgLight entirely rather than partially applying them.
    const darkCss = accentOverride
      ? accentBlock(accentOverride)
      : accentBlock(theme.accent, theme.accentHover, theme.accentBg);
    // accentLight/accentHoverLight/accentBgLight are optional -- a theme that doesn't bother with a
    // light-mode variant just uses the same accent everywhere, a legitimate choice for a first-pass
    // brand-new theme (nothing to be "faithful" to yet, unlike Plain).
    const lightCss = accentOverride
      ? accentBlock(accentOverride)
      : accentBlock(
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

  // Background tint (the Home gradient wash) -- separate override from accent. Real fix (2026-08-27):
  // this used to leave --bg-tint UNSET whenever there was no explicit user override, relying on
  // styles.css's own `var(--bg-tint, var(--accent))` fallback -- which resolves straight to accent,
  // producing the exact bug reported (both Settings swatches showing the identical accent hex, not
  // a darker variant). The real default now always comes from here, same as --accent-hover already
  // does; the CSS fallback chain stays in place as a last-resort safety net (e.g. if this fetch ever
  // fails), not as the everyday source of truth.
  //
  // Priority: (1) an explicit user override always wins outright. (2) No override, but the user DID
  // pick a custom accent (not this theme's own default) -- the bg-tint default has to be derived off
  // THAT active accent, not the theme's original, or picking a custom accent would leave the
  // background paired with a color that's no longer even showing. (3) No override, theme's own
  // accent still active -- the theme's own director-picked exact default (theme.bgTint), falling
  // back to the formula only if a theme genuinely doesn't carry one yet.
  function applyBackgroundTint(theme) {
    const bgOverride = getColorOverride(theme.id, 'bg');
    if (bgOverride) {
      document.documentElement.style.setProperty('--bg-tint', bgOverride);
      return;
    }
    const accentOverride = getColorOverride(theme.id, 'accent');
    const defaultTint = accentOverride
      ? deriveDefaultBgTint(accentOverride)
      : (theme.bgTint || deriveDefaultBgTint(theme.accent));
    if (defaultTint) {
      document.documentElement.style.setProperty('--bg-tint', defaultTint);
    } else {
      document.documentElement.style.removeProperty('--bg-tint');
    }
  }

  // Generic per-brand CSS hook -- distinct from Appearance's own [data-theme] (light/dark).
  // styles.css's Home background gradient scopes off this attribute; any future per-brand-only CSS
  // (not modeled as a brand-string slot) should too, rather than adding another bespoke attribute.
  function applyBrandAttribute(theme) {
    document.documentElement.setAttribute('data-brand', theme.id);
  }

  // Get Started book, opt-in per theme (2026-08-20) -- the same theme-DECLARED pattern
  // hasHomeBackgroundWash established, adapted for something a STYLESHEET has to see. #nav-book's
  // default-hidden state is pure CSS, so a JS-side check (the way settings-app.js reads
  // hasHomeBackgroundWash) isn't enough on its own -- the flag has to reach a selector. This is
  // that bridge: a bare boolean attribute on <html>, which styles.css keys off as [data-has-book].
  //
  // Replaces three separate [data-brand="skyrim"] rules that each assumed Skyrim was the only theme
  // that would ever have a book. A theme opts in with "hasBook": true AND a real
  // themes/<id>-book.json beside it -- the flag alone would show a button that 404s.
  function applyBookAttribute(theme) {
    document.documentElement.toggleAttribute('data-has-book', !!theme.hasBook);
  }

  // Themed display font (Theming: visual flourishes) -- Plain has no `fonts` map at all, so this is
  // a no-op for it (styles.css's var(--font-display, inherit) fallback already covers "no theme
  // font set" -- nothing here needs to explicitly unset anything). A theme WITH a fonts map picks
  // the saved choice (own localStorage key per theme, 'vct-font-<themeId>', so switching brand
  // themes later doesn't clobber a font preference already made for a different theme) or its own
  // defaultFont. The font's own stylesheet (self-hosted @font-face rules, not a CDN link) is loaded
  // once via a real <link> tag rather than fetched/inlined -- letting the browser's own font loading
  // pipeline (preload, swap timing) handle it normally.
  function applyFont(theme) {
    if (!theme.fonts || !theme.defaultFont) return;
    if (theme.fontStylesheet && !document.getElementById('theme-font-stylesheet')) {
      const link = document.createElement('link');
      link.id = 'theme-font-stylesheet';
      link.rel = 'stylesheet';
      link.href = `/${theme.fontStylesheet}`;
      document.head.appendChild(link);
    }
    const fontId = localStorage.getItem(`vct-font-${theme.id}`) || theme.defaultFont;
    const font = theme.fonts[fontId];
    if (font && font.cssFamily) {
      document.documentElement.style.setProperty('--font-display', font.cssFamily);
    }
  }

  function applyTheme(theme) {
    applyAccentStylesheet(theme);
    applyBackgroundTint(theme);
    applyBrandAttribute(theme);
    applyBookAttribute(theme);
    applyFont(theme);

    if (theme.appName) {
      const appNameEl = document.querySelector('[data-brand-slot="appName"]');
      if (appNameEl) appNameEl.textContent = theme.appName;
      // The header title's own text node just changed -- re-derive document.title (and the
      // #headerMeta label) through shell.js's setPageLabel so the app-name half of the title bar
      // picks up the new value too, using whatever page label is currently showing.
      if (window.refreshPageTitle) window.refreshPageTitle();
    }

    // Every brand-carrying container (.home-card, .tool-hero, a whole tool-area <main>, or a small
    // inline span wrapping just one cross-reference to ANOTHER tool inside a paragraph -- see
    // Settings' Mod Exceptions section for a real example) is tagged data-tool-id="<stable id>".
    // Containers can NEST (a page's own outer data-tool-id="sync" wrapping a prose mention of a
    // different tool, itself wrapped in its own inline data-tool-id="missing-files" span) -- so this
    // walks every INDIVIDUAL data-brand-slot element and asks "which is the CLOSEST data-tool-id
    // ancestor" via .closest(), rather than having each container claim every slot inside it
    // (which would let an outer container's own name overwrite an inner cross-reference's). Also
    // handles multiple same-slot occurrences sharing one container correctly (e.g. a page's own
    // breadcrumb AND a later inline mention of its own name) -- each element is looked up
    // independently, not "first match only".
    // Home-card hover tooltip showing the plain/standard name+icon (2026-08-25, director's own
    // request: "hover over The Forge, get the standard naming"). Captured HERE, right before the
    // loop below overwrites each card's name/emoji text -- safe to treat as the genuine plain
    // baseline because theme.js only ever runs applyTheme once per page load (switching Style does
    // a location.reload(), never a live re-theme), so the DOM's current text at this exact point
    // can never already be a previously-applied theme's own text.
    const plainByHomeCard = new Map();
    document.querySelectorAll('.home-card[data-tool-id]').forEach((card) => {
      const nameEl = card.querySelector('[data-brand-slot="name"]');
      const emojiEl = card.querySelector('[data-brand-slot="emoji"]');
      plainByHomeCard.set(card, { name: nameEl ? nameEl.textContent : null, emoji: emojiEl ? emojiEl.textContent : null });
    });

    document.querySelectorAll('[data-brand-slot]').forEach((el) => {
      const container = el.closest('[data-tool-id]');
      if (!container) return;
      const id = container.getAttribute('data-tool-id');
      const t = theme.tools && theme.tools[id];
      if (!t) return;
      const slot = el.getAttribute('data-brand-slot');

      if (slot === 'emoji' && t.emoji != null) el.textContent = t.emoji;
      else if (slot === 'name' && t.name != null) el.textContent = t.name;
      // cardDesc/heroBody can carry inline HTML (e.g. Update Collection's <strong> tags, &mdash;
      // entities) in the source copy, so these are set via innerHTML, not textContent.
      else if (slot === 'cardDesc' && t.cardDesc != null) el.innerHTML = t.cardDesc;
      else if (slot === 'heroTitle' && t.heroTitle != null) {
        // The emoji and title text live combined in one text node today (e.g. "⚡ Rebuild
        // Collections in Minutes, Not Hours") and no CSS depends on them being separate child
        // nodes, so the simplest faithful reproduction is to set them combined here too rather
        // than splitting tool-hero__title into child spans.
        el.textContent = t.emoji ? `${t.emoji} ${t.heroTitle}` : t.heroTitle;
      }
      else if (slot === 'heroBody' && t.heroBody != null) el.innerHTML = t.heroBody;
      else if (slot === 'landingHint' && t.landingHint != null) el.textContent = t.landingHint;
      else if (slot === 'bannerImage') applyBannerImage(el, t.bannerImage);
    });

    // Apply the hover tooltip captured above -- only for a card the theme actually renamed/re-iconed
    // (Plain, or a theme with no entry for this particular tool, leaves plain === themed and gets no
    // tooltip at all; hovering to be told the name you're already looking at would be pointless).
    // A small CUSTOM tooltip, not the native `title` attribute -- the native one's own show delay is
    // entirely browser-controlled with no CSS/JS hook to adjust it, and the director specifically
    // asked to tune the hover delay (2026-08-25), which is only possible by owning the show/hide
    // timing ourselves. wireHomeCardTooltip (below) does the actual hover-timer + positioning work;
    // this loop only decides WHICH cards get one and what text to show.
    plainByHomeCard.forEach((plain, card) => {
      const id = card.getAttribute('data-tool-id');
      const t = theme.tools && theme.tools[id];
      if (!t) return;
      const themedName = t.name != null ? t.name : plain.name;
      const themedEmoji = t.emoji != null ? t.emoji : plain.emoji;
      if (themedName === plain.name && themedEmoji === plain.emoji) return;
      wireHomeCardTooltip(card, [plain.emoji, plain.name].filter(Boolean).join(' '));
    });

    // Premium badge tooltip (Nexus Orange "N" mark) -- reuses the same tooltip mechanism as
    // home-card branded names above, but on a sibling badge element rather than the card itself.
    document.querySelectorAll('.home-card__premium-badge').forEach((badge) => {
      const cardWrap = badge.closest('.home-card-wrap');
      if (!cardWrap) return;
      wireHomeCardTooltip(badge, 'Works best with Nexus Premium');
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
      const bannerEl = container.querySelector('[data-brand-slot="bannerImage"]');
      if (bannerEl) applyBannerImage(bannerEl, s.bannerImage);
    });
  }

  // Shared by both the per-tool and per-section passes above -- takes the actual <img> element
  // itself (not a container to search within). An entry with no bannerImage (Plain never has one)
  // leaves the <img> exactly as it started (.hidden, no src), so nothing renders and no
  // failed-request console noise appears either.
  function applyBannerImage(bannerEl, bannerImage) {
    if (bannerImage) {
      bannerEl.src = bannerImage;
      bannerEl.classList.remove('hidden');
    } else {
      bannerEl.classList.add('hidden');
      bannerEl.removeAttribute('src');
    }
  }
})();
