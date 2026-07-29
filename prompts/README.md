# Terminal prompts — v0.4 design pass (2026-07-28)

A record of the prompts handed to terminal Claude Code during the v0.4 UI work, in the order they
happened. Kept for reference — both to re-run/adapt them and as examples of how to phrase a handoff.

The two **full build prompts** live next door in `design/` (they're big and self-contained); the
**follow-up / fix / polish** prompts are collected below. Each was written to be pasted into
`claude` running in this repo, and each ends with a `npm run web` verify step.

Rough status key: ✅ done · ⏳ queued/in progress · ⭕ pending decision.

---

## Full build prompts (in `design/`)

- **Home landing page** → [`design/BUILD-PROMPT.md`](../design/BUILD-PROMPT.md) ✅
- **Settings two-pane reorg** → [`design/BUILD-PROMPT-settings.md`](../design/BUILD-PROMPT-settings.md) ✅

---

## Follow-ups, fixes & polish (in order)

### 1. Finish Home — add pins + align taglines ✅
*Home was built before pinning and the final taglines existed.*
```
The Home landing page is already built, but it predates two things we finalized in the design
docs. Read DESIGN.md's "Home / landing page" and "Pinning" sections and design/vortex-home-mockup.html,
then:
1. Add pinning to the Home cards, per BUILD-PROMPT.md step 5 and the "Pinning" section: a star on
   each card (wrap each card in .home-card-wrap with a SIBLING .home-card__star button — not nested
   inside the card <button>), a "📌 Pinned" row above the category sections built from pinned tools
   (hidden when empty), persisted, star in --accent, toggled in place with no full re-render.
2. Align each card's one-line description with the finalized taglines in design/vortex-home-mockup.html.
Verify with npm run web: pinning works, nothing flickers, Home matches the mockup.
```

### 2. Home pinning — change duplicate → move ✅
```
On the Home page, change pinning from DUPLICATE to MOVE: a pinned tool should appear ONLY in the
📌 Pinned row, not also in its category section. Update the render so each category section excludes
pinned tools, and hide a category section that becomes empty because all its cards are pinned. See
the updated DESIGN.md "Pinning" section and design/vortex-home-mockup.html. Keep no-flicker — on
toggle, re-render only the Pinned row and the affected section. Verify with npm run web.
```

### 3. Home hero copy + Settings rail divider ✅
```
Two small fixes:
1. Home hero body — replace with this exact text: "Pick a tool to get started. Everything here
   works on collections you've already installed in Vortex—rebuild them faster, keep your Ignored
   and Disabled mods through an update, sort out conflict rules, and see how it all went."
2. Settings rail divider — it's rendering directly under the "📌 Pinned" label. It should sit
   BETWEEN the pinned group and the unpinned list: label → pinned rows → divider → the rest. Match
   design/vortex-settings-mockup.html.
Verify with npm run web.
```

### 4. Tool-page breadcrumb (Home › area) ✅
```
Add a tool-page breadcrumb eyebrow to every tool page. Now that the top nav is gone, a user can't
tell which tool they're in — the tool-hero title is a value pitch, not the tool name. See DESIGN.md
"Tool page breadcrumb — name where you are" and design/vortex-tool-eyebrow-mockup.html.
Add a .tool-eyebrow element immediately above each .tool-hero__title: a clickable "Home" (color
var(--accent), returns to the Home area — same as the logo) + a "›" separator + the area name.
Uppercase, muted, letter-spaced per the mockup/DESIGN spec; reuse existing tokens; add the CSS to
styles.css. Per page:
- Rebuild Collection → "Home › Rebuild Collection"
- Update Collection  → "Home › Update Collection"
- Rules Generator    → "Home › Rules Generator"
- Reports (all sub-tabs)   → "Home › Reports"
- Utilities (all sub-tabs) → "Home › Utilities"
(Reports/Utilities keep their sub-nav, which names the specific report/utility.)
Verify with npm run web: every tool page names where you are, Home returns to the launcher. Note it
in TECHNICAL.md.
```

### 5. Rules Generator "Nothing to do" — collapsed chips ⏳
```
Clean up Rules Generator's "Nothing to do" section (mods added to the new collection with no
relationship to anything in the original — currently a flat one-name-per-row list). See DESIGN.md
"Informational name lists — collapsed neutral chips" and design/vortex-nothing-todo-mockup.html.
Keep the "Nothing to do" neutral badge header. Under it, add a collapsed-by-default <details>:
summary reads "▸ <N> mods added with nothing needed — show them" (caret rotates on open), expanding
to the description line + a wrapping chip grid. Each chip: background var(--neutral-bg), 1px
var(--border), color var(--text-muted), border-radius 8px, padding 6px 12px, font-size 13px;
container flex/wrap with 8px gap. Chips are non-interactive labels. Reuse existing tokens + the
app's disclosure pattern; add CSS to styles.css. Verify with npm run web.
```

### 6. Archive Finder page — group into cards ✅
```
Tighten up the Archive Finder page (Utilities → Archive Finder). See DESIGN.md "Tool page layout —
group controls into cards, cap the width" and design/vortex-archive-finder-mockup.html. Load the
plain-language-writer skill for the copy.
- Group the loose controls into two .settings-group cards: "Your archive index" (scan-status line +
  Save & Rescan + the file-extensions-to-index manager) and "Search" (the Find individual files /
  Display archive radios + query input + Search, plus Select all / Clear selection / Extract selected).
- Cap the page content width to ~1080px, centered — scope it to this tool area, NOT the global .app-main.
- Tighten the vertical spacing between groups to match the mock.
- Fix the copy: "4,526 archive(s) indexed, 12,823 matched file(s)" → "4,526 archives indexed ·
  12,823 files matched · last scan …" (no "(s)" shorthand). Keep the Tip callout.
Reuse existing tokens and components — no new colors. Verify with npm run web.
```

### 7. Archive Finder results table — overhaul ✅
*Two build-time judgment calls (both correct): button labels kept Title Case to match the app's
convention; the selection bar stays visible in Display-Archive tree mode too (shared Extract flow).*
```
Overhaul the Archive Finder search-results table. See DESIGN.md "Selectable lists — the standard
select-and-act pattern" (paginated-table tier) and design/vortex-results-table-mockup.html. Reuse
existing tokens/components; load plain-language-writer for any copy.
Look:
- Standard .plan-table in .plan-table-wrap (uppercase-muted sticky header, hairline dividers, rounded
  wrapper). Row states: hover = --surface-2; checked/selected row = faint --accent-bg with a 3px inset
  --accent edge on the first cell — NO bright/white rows. Subtle zebra (nth-child(even) ~2% white).
- Archive names: show the readable mod name; strip the Nexus-style -<id>-<ver>-<timestamp> tail when
  it parses confidently, else fall back to the full name. Full filename = title tooltip. Add a
  hover-revealed copy button (⧉) that copies the full path (downloads folder from Settings + filename)
  and flips to ✓ on copy. Make the "N matching files" expander a quiet caret + accent text.
Selection (all six):
1. Persist selection across pages AND page-size changes — track by id, not rendered rows.
2. Header checkbox selects the visible page; when more results exist, banner "All N on this page are
   selected. Select all M results?" (Gmail/GitHub pattern).
3. Count on the action button — "Extract selected (N)" — plus a live "N of M selected" readout.
4. Shift-click range select on the checkboxes.
5. Reset selection when a NEW search runs; keep it across paging within the same results.
6. "Show selected only" toggle to review before extracting.
Buttons: Select all · Invert selection · Clear selection on the left; "Extract selected (N)" primary,
right-aligned. Verify with npm run web (50+ results, select, page around, invert, shift-click, copy).
```

### 8. Final layout polish + autofill ✅
*Combined pass — the earlier standalone autofill prompt was folded into #4 here.*
```
Final polish pass before commit (see design/vortex-home-mockup.html and design/vortex-settings-mockup.html;
DESIGN.md updated to match):
1. Home grid width — cap the Home content to ~1280px, centered. Scope to Home only (a wrapper inside
   #area-home or the home grids' container); do NOT change the global .app-main.
2. Equal-height Home cards — set .home-card-wrap and .home-card to height:100% so cards in a row match
   height; with the flex column + .home-card__desc{flex:1}, "Open →" pins to the bottom.
3. Settings line length — cap the content column #settingsPanes to ~960px so callouts/hints wrap at a
   readable width. Leave the rail as-is.
4. Autofill popup — the browser password manager pops a "No items to show / + New login" prompt on the
   Settings fields. Add autocomplete="off" to the text/path inputs (there's no <form> element, and
   don't add one — inner buttons would default to type=submit). On the Nexus API key input also add
   data-lpignore="true", data-1p-ignore, data-form-type="other" (and if it's type=password, switch to
   masked text / autocomplete="new-password").
Verify with npm run web. Light mode already confirmed good.
```

### 9. Normalize all select-and-act lists ⭕ (hold until Archive Finder is committed)
```
Normalize every "select-and-act" list in the app onto DESIGN.md "Selectable lists — the standard
select-and-act pattern" (and design/vortex-results-table-mockup.html). Load plain-language-writer.
First AUDIT the code and list every place the user checks items and runs a bulk/primary action, and
share which tier each gets (core vs paginated) BEFORE mass-editing. Known starting points (find any
I missed):
- Archive Finder results + failed-extraction list — paginated tier
- Vortex Scrub / Clean Up: needs-review, main, cross-check lists — core tier
- Settings exclude lists (staging, archives) — core tier
- Check work-through-app.js, sync-app.js, rules-generator-app.js for multi-select lists
Build ONE reusable selection helper and wire each list to it (not copy-pasted). CORE for every list:
Select all · Invert · Clear (left), bulk action right-aligned with its count, live "N of M selected"
readout, shift-click range select, no-bright-row hover/checked styling. PAGINATED extras (persist
across pages, page-vs-all banner, reset on new result set, show-selected-only, .plan-table + zebra)
only where the list pages. Preserve each list's existing action logic and confirm modals — you're
standardizing the selection UX, not changing what the buttons do. Verify each with npm run web.
```

---

### 10. Normalize spacing across all pages ⭕
*Terminal fixed only the Archive Finder "Search" card; roll the DESIGN.md spacing standard out everywhere.*
```
Apply DESIGN.md "Spacing — give stacked things room, consistently" across the whole app. The terminal
fixed only the Archive Finder "Search" card; normalize the rest.
First AUDIT every page and list the stacked cards/sections that sit flush or use inconsistent gaps
(12/16/20px). Then converge them to a consistent 24px (1.5rem) vertical gap between stacked
cards/sections, and the same ~24px below each tool-hero before the first block. Where a group of
cards shares a wrapping container, prefer `gap: 24px` on the container over per-element margins;
otherwise a single consistent bottom margin. Move existing 16–20px components (.settings-group,
.sync-phase, tool-page cards, two-pane content blocks) to the standard. Consider a `--stack-gap: 24px`
token defined once. Don't change padding INSIDE cards. Reuse tokens; no new colors. Verify with
npm run web that every page has even breathing room and nothing sits flush.
```

---

### 11. Breadcrumb on ALL views — audit ✅
*Audit: only Rebuild Collection had routed sub-views (fixed). Kept 2 back controls: Update Compare's cross-tool jump + Archive Finder's in-place "Back to results."*
*First pass only hit the tool-hero landing views; deeper flow views (Rebuild plan/progress, etc.) were missed.*
```
Inventory every page/view/sub-view in the app and make sure each shows the breadcrumb eyebrow
(Home › <area>), per DESIGN.md "Tool page breadcrumb — name where you are" (now clarified: it applies
to EVERY view, not just the tool-hero landing). The first breadcrumb pass only hit the landing views;
deeper flow views were missed — e.g. Rebuild Collection's plan/confirmation and progress screens
(they show "← Back to Collections" + a heading but no breadcrumb), Update Collection's steps, any
log/report sub-views.
AUDIT first: list every view/sub-view and whether it currently shows the breadcrumb. Then add the same
.tool-eyebrow (Home › <area>, Home links to the Home area) at the top of every view that's missing it,
above the view's own heading. The breadcrumb REPLACES the old navigation: remove the "← Back to
<tool>" buttons (.btn--nav.btn--back) that just return to the tool landing, and wire the breadcrumb's
area segment to that landing view (e.g. Rebuild Collection → collection picker, where "Back to
Collections" went); Home → Home area. On the tool's own landing view the area segment is the current
location (not a link). Only keep/flag a back control if it's a genuine step-back within a multi-step
flow that goes somewhere OTHER than the tool landing.
Reuse the existing .tool-eyebrow styling/tokens. Verify with npm run web that every view names where
you are and Home works from all of them.
```

---

## Docs & release ⭕

### README refresh
```
Refresh README.md against docs/DOCUMENTATION-STYLE.md and load plain-language-writer. Add the new
Home landing page and the reorganized Settings to Key Features and the Overview (consider a Home
screenshot in Overview). Keep the section order and voice; flag judgment calls; keep tech detail in
TECHNICAL.md; use real — em dashes.
```

### Release notes (v0.4.0 draft already at `github-releases/release-notes-v0.4.0.md`)
The reusable release-notes and README prompts also live in
[`docs/DOCUMENTATION-STYLE.md`](../docs/DOCUMENTATION-STYLE.md) under "Prompts" — use those as the
templates for future versions.

---

*Convention that emerged this session: point the terminal at the relevant `DESIGN.md` section + the
`design/*.html` mockup, list the concrete changes, and end with a `npm run web` verify step. Keep the
design side and the terminal to one owner per file (design docs vs. `TECHNICAL.md`/code).*
