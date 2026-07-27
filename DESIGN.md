# Design Guide

How this project should look, feel, and read — for every page, modal, and report, today and in
every future change. The goal is simple: **a user moving between Rebuild Collection, Update
Collection, Settings, and all three Reports sub-tabs should never notice a visual or tonal seam.**
Same colors, same components, same voice, everywhere.

This file is the front door for "how do I make this look right." It doesn't repeat every piece of
implementation rationale — where something is explained in more depth in `TECHNICAL.md` (e.g. *why*
the callout severity system exists), this file links there instead of duplicating it, so the two
docs don't drift out of sync.

## The golden rule

Before adding or changing any UI, look for an existing pattern here (or directly in
`web/public/styles.css`) that already solves the problem, and reuse it. Only design something new
when nothing existing fits — and when you do, add it to this document immediately, in the same
change, so the next person (or the next session) reuses it instead of inventing a second way to do
the same thing.

## Voice & tone — all user-facing text

Every piece of text a user actually sees — button labels, callouts, status/error messages, modal
copy, settings descriptions, report headings and body text — must follow the **`plain-language-writer`**
skill: `~/.claude/skills/plain-language-writer/SKILL.md` (a user-level skill, not specific to this
project). **Load it explicitly with the `Skill` tool before writing or editing any user-facing
copy** — it's a living document the user keeps refining with real confirmed examples, so re-reading
it fresh each time matters more than memorizing a summary.

The short version, for quick reference (the skill file itself is the source of truth):
- Plain language, active voice, no developer jargon in front of a user. Never say "state database",
  "modId", "rules array", "collection.json", "outPath" etc. to a user — translate to what they'd
  recognize (see the skill's Jargon Translator table).
- Direct and action-oriented: lead with the action, use imperative verbs ("Click", "Select",
  "Choose").
- Bold or quote exact UI element names; hyphenated location words ("upper-right corner", not "top
  right").
- Ellipsis (`…`) on a button label ONLY when it opens a **native OS dialog** (e.g. "Browse…") —
  never for an in-app modal or confirmation, even one that asks for more input.
- Short, complete sentences. No dense compound sentences, and no sentence fragments (a common trap:
  "Setting N mod(s) to ignored..." is a gerund phrase, not a sentence — lead with a real subject and
  verb instead: "This sets N mod(s) to ignored...").
- A confirm dialog's shape: lead with the actual action as its own complete sentence, then any
  safety/technical detail as a separate trailing sentence. Don't cram both into one clause.
- Wording that's a genuine judgment call (not obviously right or wrong) gets surfaced for
  confirmation before changing — don't silently bake in a preference nobody asked for.

**Technical content stays technical.** Architecture notes, implementation rationale, "why this
approach," API/schema detail, Future Work — all of that belongs in `TECHNICAL.md`'s own denser,
engineer-facing voice. It must never leak into user-facing copy. A real example of what NOT to do,
caught and fixed 2026-07-25: a report callout that told the user *"collection.json has no per-mod
enabled/disabled field (confirmed against Vortex's own source)"* — true and useful for a developer,
meaningless and jargon-heavy for the person looking at the report. The fix said only what it means
for them: *"these mods are set to Disabled, but we can't switch them off automatically for you."*

## Color & severity system

Single source of truth: the CSS custom properties in `web/public/styles.css`'s `:root` block —
`--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--success`,
`--warning`, `--danger`, `--neutral` (each with a matching `-bg` tint for a soft background fill).
**Never hardcode a color literal in new markup or CSS** — always reference the variable. That's what
makes the light theme, dark theme, and "follow system" all work automatically for anything new,
with zero extra effort.

Four severities, used identically everywhere something needs a color-coded meaning — callouts,
modals, badges, and status-pills all share the exact same mapping (full rationale in
`TECHNICAL.md`'s "Callout severity conventions"):

| Severity | Color | Icon | When to use it |
|---|---|---|---|
| Info | blue (`--accent`) | `&#9432;` circled-i | Plain status or instructions — nothing is wrong. |
| Success | green (`--success`) | checkmark-style | Something completed, or worked correctly. |
| Warning | amber (`--warning`) | `&#9888;` triangle-alert | Needs attention, but isn't blocking. |
| Critical | red (`--danger`) | `&#9888;` triangle-alert | A real failure, or a step that cannot proceed. |

Outside of that four-color system, plain grey (`--text-muted` / `.muted`) is for ordinary secondary
text with **no severity implied at all** — most of this app's body copy. Never invent a one-off color
for a status; pick one of the four above, or use plain muted grey if nothing is actually wrong.

## Header nav ordering and Settings' icon treatment (2026-07-26)

Main nav order (left to right): Rebuild Collection, Update Collection, Rules Generator, Reports.
**Settings is not in this row** — it's a one-and-done config page, not a workflow tab you switch
between like the others, so it lives as a small gear icon (`.settings-gear-btn`, reusing the same
`&#9881;` glyph as the header's own logo) at the header's far right, in a `.app-header__right`
wrapper alongside the page-label breadcrumb. It still shares the `.nav-tab`/`id="nav-settings"`
plumbing shell.js's generic `TOOL_AREAS` loop expects (click handling, active-state toggling) —
only the visual treatment differs. When adding a new top-level workflow area, add it to the main
nav row in this same left-to-right ordering convention (newest addition goes right of Update
Collection, before Reports) — Settings is the one and only exception that goes in the icon slot.

## Core components — reuse these, don't reinvent them

- **Buttons**: `.btn--primary` (the one action to take on this screen), `.btn--ghost` (secondary /
  cancel), `.btn--nav.btn--back` (every "Back to X" navigation control, always this exact pair of
  classes — never ghost or primary for a back button), `.btn--small` as a size modifier on any of
  the above.
- **Cards**: `.settings-group` / `.sync-phase` — a bordered, padded box for a distinct chunk of a
  page (Settings' three tool-area cards, Update Collection's four numbered steps).
- **Badges & status-pills**: `.badge` (a small pill, usually with a count) and `.status-pill` (a
  colored label inside a table cell). Generic severity variants exist for both —
  `.badge--info/success/warning/critical/neutral` and
  `.status-pill--info/success/warning/critical/neutral` (added 2026-07-25 for the Compare Report,
  meant to be reused by anything future, not just that one report).
- **The "click a stat to filter a list" pattern**: `.badge--clickable` + a `data-status` attribute,
  paired with table rows carrying a matching `data-status` — clicking a badge shows only matching
  rows, clicking `.badge--show-all` clears the filter. This is **the** standard way to let a user
  narrow a categorized list in this app. Used by Stats Report's Current Issues, Work Through Report,
  the Ignored/Disabled report, and the Update Compare Report. **Any new report or list that shows
  categorized data should copy this exact mechanism** (badges above, one combined table below, same
  small inline filter script) rather than inventing per-page filtering, multiple stacked tables, or a
  collapsible-sections approach.
- **Callouts**: `.callout.callout--{severity}` — an inline, non-blocking status/warning/note box on
  a page. This is the default choice for "something the user should know," short of a full modal.
- **Modals**: `.modal-overlay > .modal.modal--{severity}` for anything that **blocks** the user until
  they resolve it (e.g. "Vortex is currently running", "Can't reach the server"). Reserve a
  page-level banner for a **non-blocking** advisory the user can ignore and keep working around (see
  TECHNICAL.md's "prefer a shared centered modal over a banner for any genuinely blocking condition"
  rule) — if in doubt, ask: can the user still do something useful elsewhere on this page right now?
  If no, use a modal. If yes, a banner is fine.
- **Tables**: `.plan-table` inside `.plan-table-wrap`, always — every data table in this app, no
  exceptions, including inside a server-rendered report loaded in an iframe.
- **Forms**: `.field-group` + `.field-label` above an `.input`/`.select` variant; `.checkbox` for any
  toggle (works for a radio `<input>` too — same flex-row + accent-color styling, no
  checkbox-specific shape is forced).
- **In-app reference link**: `.rg-mod-link` — accent-colored, underline-on-hover only, opens a
  read-only reference view in a real separate window (`window.open('', ...)` + a directly-written
  document, since there's no static URL to point at — the content comes from data already in memory
  client-side) rather than navigating anywhere. Updated 2026-07-26: this used to open an in-page
  modal overlay; the user clarified they want a genuine separate OS-level window so it can stay open
  alongside the tool for comparison, same as `.mod-name-link`'s external-link windows below — just
  with client-rendered content instead of a server URL. The two link classes stay visually distinct
  (different styling) since their content source differs, but both now share the same "force a real
  window, not a tab" mechanism.
- **Rules Generator review choice**: `.rg-choice-row` inside a `.settings-group` card — one
  radio-pair choice ("which of these two is right?"), used whenever a rule could point at either
  an original-collection mod or its new-collection counterpart. Reuse this for any future
  "pick between two known options" choice rather than inventing another pattern.
- **Links**: `.mod-name-link` / `.archive-link` (accent-colored, no underline for mod-name links, no
  default browser purple/blue) for anything that links out (typically to Nexus).
- **Checkbox list + Select all + bulk action(s)** (confirmed 2026-07-27, Clean Up report/Settings'
  exclude list): a "Select all" checkbox in its own `.field-group` sitting ABOVE and OUTSIDE the
  `<ul class="sync-result-list">` of per-item checkboxes, with the bulk action button(s) (Delete
  All / Remove All / etc.) below the list. The list of items should sit **visibly indented** under
  "Select all" — `.sync-result-list` itself is zero-padding (`padding: 0`) so this indent is NOT
  automatic; it only happens for free when the list happens to sit inside a `.callout` (which adds
  its own `.callout ul { padding-left: 20px }`). Outside a callout, add an explicit
  `padding-left: 20px` on that list's own id/class to match (see `#cleanupResultsList` in
  styles.css) — confirmed 2026-07-27 the two need to look identical, not just "close enough."
  Don't drop "Select all" just because an "All" button already exists nearby: they solve different
  problems (confirmed the hard way, added/removed/re-added same day) — "All" is fastest for
  all-or-nothing, but "select all, then uncheck the few you want to keep" is the faster path once
  a list is long and you want to act on *most* of it.

## External links open in a separate window, not a tab

Standing rule (2026-07-25): **unless explicitly asked otherwise, an external hyperlink (a Nexus mod
page, or anything else leaving this app) opens in its own separate browser window — never as a new
tab in the same browser window.**

The technical reality worth knowing before touching this: a plain `<a target="_blank">` (or a bare
`window.open(url, '_blank')`) is treated as "open in a new tab" by every modern browser, and a
website cannot change that — tab-vs-window is the browser's own behavior now, not something a page
controls. The one thing that DOES reliably force a real separate OS window in Chromium browsers is
`window.open()` called with explicit `width`/`height` window-features from inside a genuine click
handler (not a bare href, and not a scripted/synthetic click — it needs real user activation or the
popup gets blocked). That window is a stripped-down "popup" (no tab strip, no address bar, no
bookmarks bar) rather than a full normal browser window with chrome — that trade-off is unavoidable
and already accepted here.

**The established pattern** (first shipped in `web/rebuild-routes.js`'s log-view report, mirrored
identically in `lib/vortex-sync/report.js`'s Compare Report):
```html
<a class="mod-name-link" href="...", target="_blank" rel="noopener">Mod Name</a>
```
```js
// target="_blank"/rel="noopener" stay on the <a> itself purely as a middle-click/ctrl-click
// fallback (those bypass this click handler entirely and use the browser's own default).
document.querySelectorAll('.mod-name-link').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(a.href, '_blank', 'noopener,width=1200,height=900');
  });
});
```
Any new external link added to this app (a mod page, a Nexus profile, anything leaving the app)
should copy this exact `.mod-name-link` + click-handler pattern rather than a bare `target="_blank"`
anchor — that's what actually produces a separate window instead of a tab.

**Gotcha confirmed live (2026-07-26): drop `noopener` for a window you need to keep writing into.**
`.mod-name-link` gets away with `noopener` because it only ever sets a static `href` and never touches
the window again afterward. `.rg-mod-link` (Rules Generator's "Current rules for X" reference view,
`rgOpenOldRulesWindow` in `rules-generator-app.js`) has no URL — it opens a blank window and writes
generated HTML into it via the returned reference (`win.document.write(...)`). With `noopener` set,
Chrome still opens the window but hands script back `null` for the reference — the window pops open
and stays permanently blank, since `document.write()` never gets a chance to run. Any future
"open a window and write dynamic content into it" case (as opposed to "open a window at a known URL")
must omit `noopener` for the same reason.

## Reports must be indistinguishable from each other

Explicit standing rule (2026-07-25): **Stats Report, Work Through Report, and Update Compare
Report — and any report added after this — must share identical visual language.** Same badge-filter
mechanism, same table style, same color severities, same header and spacing rhythm. A user should
only be able to tell which Reports sub-tab they're on by the *content*, never by the *look*. When
building a new report, start by copying an existing report's markup/CSS classes, not by designing
from a blank page.

This applies even when a report is technically implemented differently under the hood — e.g. the
Update Compare Report is a separate, server-rendered HTML document loaded in an `<iframe>` (it has to
be, since it's generated by `lib/vortex-sync/report.js` independent of the SPA), while Stats Report
and Work Through Report are rendered directly in the main page's own DOM. That implementation detail
must be invisible to the user — it still links the same `/styles.css`, uses the same theme-bootstrap
snippet (see below), and reuses the same badge/table components as its two siblings.

## Theming

- Dark is the default/fallback theme. Light and "follow system" are both fully supported through the
  same CSS variables (`@media (prefers-color-scheme: light)` and the `:root[data-theme]` overrides
  in `styles.css`) — this should never need touching for a normal UI change.
- **Any new page or standalone document** (including a server-rendered report opened in an iframe or
  a new tab) must:
  1. Link the same `/styles.css` — never write a separate, one-off stylesheet.
  2. Include the same small theme-bootstrap snippet used by `index.html` and the Compare Report:
     ```html
     <script>
       var t = localStorage.getItem('theme');
       if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
     </script>
     ```
     `localStorage` is shared across same-origin documents (including an iframe), so this keeps a
     standalone page in sync with the user's explicit theme choice, not just their OS/browser
     preference.
  3. Skip duplicating the app's own header/nav if the page is going to be embedded inside the app's
     existing chrome (e.g. an iframe under Reports) — that chrome is already visible one level up;
     repeating it reads as "a page inside a page." A page that's genuinely standalone (opened via a
     real navigation, like the Ignored/Disabled report) DOES get its own header/nav, matching
     `sync-routes.js`'s `renderIgnoredDisabledReport` exactly.

## How this document gets used

- Read this file before making **any** visual or user-facing change — new pages, new modals, a
  restyled report, new copy, anything the user will actually see.
- If an existing pattern already covers what's needed, use it as-is, unmodified.
- If something genuinely new is needed, design it consistent with everything above, then **add it to
  this document in the same change** — this file is only useful if it stays current.
- This is a standing instruction enforced via this project's own `CLAUDE.md`, which every future
  Claude Code session in this repo loads automatically — see that file for the exact pointer.
