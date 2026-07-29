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
| Warning | amber (`--warning`) | ⚠️ | Needs attention, but isn't blocking. |
| Critical | red (`--danger`) | 🛑 | A real failure, or a step that cannot proceed. |

**Icons updated 2026-07-27, twice the same day**: first, every `&#9888;`/bare `⚠` was swapped for
the colorful emoji ⚠️ (U+26A0 + variation-selector-16) instead of the flat black-and-white HTML
entity glyph — reads more eye-catching, matching this app's broader move toward emoji-led headings
(see the Tool intro banner section above). Later the same day, Critical was split off to its own
icon, 🛑 (stop sign) — Warning and Critical had been sharing the same triangle-alert glyph,
distinguished only by color; the user wanted Critical to read as visually distinct, not just
differently-colored, from Warning. **When adding a new critical-severity callout/modal, use 🛑, not
⚠️** — check the container's actual CSS class (`callout--critical`/`modal--critical` vs.
`callout--warning`/`modal--warning`) to pick the right one, since a title alone (e.g. "Double-check
this") doesn't reliably tell you the severity.

**The actual test, confirmed with the user 2026-07-27**: 🛑 = "you can't continue at all" (a hard
blocker — the action will be flatly refused, or something has genuinely failed). ⚠️ = "tread
lightly" (proceed with caution, nothing is blocking yet). This is why "Vortex must be closed before
continuing" is 🛑, not ⚠️, on the Rebuild This Mod confirm modal — the request is refused outright
if Vortex is open, not just risky to proceed with. Ask this question first when picking an icon for
new copy, before defaulting to whichever one a nearby example happens to use.

**Confirm-modal structure, same day**: a modal that has BOTH a plain description of what an action
does AND a hard blocking precondition should split them into two visually distinct pieces, not one
run-on paragraph — a plain `<p>` for the description, plus its own separate `.callout--critical`
(🛑) directly inside the modal for the precondition. See `#mmRebuildConfirmModal` for the reference
example. The modal's own `<h2>` gets a tool/action icon (🛠️ for "Rebuild Single Mod from Archive"),
not a severity icon — severity belongs to the specific blocking-precondition callout inside, not
the modal's title, which is just naming the action.

Outside of that four-color system, plain grey (`--text-muted` / `.muted`) is for ordinary secondary
text with **no severity implied at all** — most of this app's body copy. Never invent a one-off color
for a status; pick one of the four above, or use plain muted grey if nothing is actually wrong.

**Wrapped callout titles (2026-07-28)**: every `.callout__title` is one plain text string ("🛑 Make
sure…", no separate icon markup), so a long title that wraps to a second line used to fall flush to
the container's own left edge instead of lining up under the actual text. Fixed with a CSS hanging
indent (`text-indent: -1.65em; padding-left: 1.65em;` on `.callout__title`) — verified via direct
in-browser pixel measurement across four different icons (🛑 ⚠️ 🚀 🧩) at this class's real 15px
font-size, each landing within 0.02px of the first line's own text. Applies automatically everywhere
this class is used; no HTML/JS changes needed per callout.

## Tool intro banner, not a redundant heading (2026-07-27)

When a tool page sits behind its own sub-nav button (e.g. Utilities' "Missing Masters" / "Vortex
Scrub" pair), don't ALSO put a plain `<h2>Tool Name</h2>` at the top of the page body -- the sub-nav
button directly above already names it, so the heading is pure redundancy. Replace it with a
`.tool-hero` intro banner that pitches the tool's value instead:

```html
<div class="tool-hero">
  <h2 class="tool-hero__title">🧩 Triage Missing Masters in Seconds</h2>
  <p class="tool-hero__body">Easily pinpoint missing master files and instantly see every mod
  relying on them&mdash;all in one clear view! Designed to streamline your troubleshooting, this
  tool takes the hassle out of tracking down broken dependencies so you can jump straight into
  Vortex and fix them with confidence.</p>
</div>
```

The copy itself follows the `plain-language-writer` skill's **"Special Feature & Utility Overviews
(What & Why)"** section — load that skill before writing one of these banners, don't improvise the
shape from scratch:
- **Lead with flair**: a bold, catchy title prefixed with a contextual emoji (🧩, ⚡, 🔍, 🛠️, etc.)
  to draw the eye immediately.
- **Explain the what & why**: 2-3 punchy, encouraging sentences combining what the tool does and why
  the user needs it — the core value (saving time, reducing frustration, replacing manual digging).
- **Acknowledge the workflow**: name where the user actually finishes the job, if it's a different
  tool than this page (e.g. "diagnose here, then fix it in Vortex").

First shipped on Missing Masters, replacing its old `<h2 class="settings-section-title">Missing
Masters</h2>` + plain description paragraph. **This is the standard going forward** — every tool
page should get the same treatment, not just new ones.

**Rolled out to every remaining tool page (2026-07-28)**: Rebuild Collection, Update Collection,
Rules Generator, and all 4 Reports sub-tabs (Stats, Work Through, Update Compare, Rules Generator
Report) all now have one — every top-level tool area and every Reports/Utilities sub-tab in the app
follows this convention. Two placement variants, matching whether the page already had real,
non-redundant view-specific text right below the old heading:
- **Replace** the old `<h1>Tool Name</h1>` + description entirely (Update Collection, Rules
  Generator, and all 4 Reports sub-tabs) — the removed text was purely restating the tool's own name
  and a one-line summary, fully superseded by the banner.
- **Add above** the existing heading, not replacing it (Rebuild Collection only) — its own
  `<h1>Choose a collection</h1>` is genuine per-view instructional text (which collection-picker view
  the user is on), not a redundant tool-name heading, so it stays; its OWN description paragraph
  underneath (which had become redundant with the new banner) was trimmed instead.

Second example, Vortex Scrub (2026-07-27) — a case where the workflow is entirely self-contained
(scan, review, and delete all happen on this same page, no handoff to another app like Missing
Masters has), so the "acknowledge the workflow" beat leans on *how easy* the in-app path is instead
of naming a destination elsewhere:

```html
<div class="tool-hero">
  <h2 class="tool-hero__title">🧽 Scrub Away Clutter in Seconds</h2>
  <p class="tool-hero__body">Easily spot staging folders and archives that Vortex has quietly
  stopped tracking&mdash;no digging through anything by hand! Designed to take the guesswork out of
  cleanup, this tool shows you exactly what's safe to remove so you can reclaim disk space with
  confidence.</p>
</div>
```

Icon choice: picked to evoke the tool's own name/action specifically (🧽 for "Scrub"), not just
"cleaning" generically — same logic as 🧩 for "Missing Masters" evoking a puzzle piece that's
missing. When choosing an icon for a future banner, look for one that maps to the tool's specific
verb/name, not a generic "success"/"tool" icon.

## Tool page breadcrumb — name where you are (2026-07-28)

Removing the top nav (see the Home / landing page section) took away the one thing that told a user
*which tool they're in* — the `.tool-hero__title` is a value pitch ("🔗 Skip Re-Resolving Conflicts
You Already Fixed"), not the tool's name, and the header breadcrumb on the far right is too quiet to
carry it alone. So every tool page now gets a small **breadcrumb eyebrow** immediately above its
`.tool-hero__title`. Reference mockup: `design/vortex-tool-eyebrow-mockup.html`.

- `.tool-eyebrow`: `font-size: 12px; font-weight: 600; letter-spacing: .09em;
  text-transform: uppercase; color: var(--text-muted)`, `margin: 0 0 8px`, sitting directly above
  the tool-hero title. It reads **Home** `›` `<area>`: **Home** is `var(--accent)` and returns to
  the Home area on click (same destination as the logo); the `›` separator and area name are muted.
- Per page: `Home › Rebuild Collection`, `Home › Update Collection`, `Home › Rules Generator`; and
  `Home › Reports` / `Home › Utilities` on those two areas — their sub-nav already names the specific
  report/utility, so the eyebrow names only the area.

**This intentionally reverses the older "Tool intro banner, not a redundant heading" rule above.**
That rule was correct *while the nav existed* — the nav named the tool, so a tool-name heading was
pure redundancy. Removing the nav removed that source of the name, so re-introducing it — as a
compact breadcrumb, not a full `<h2>` — serves the same intent (know where you are) rather than
contradicting it. The tool-hero title stays the value pitch; the eyebrow carries the name and the
way back Home.

**The breadcrumb goes on EVERY view within a tool — not just the tool-hero landing (2026-07-28).**
A tool's deeper views don't have a `.tool-hero`, so the first pass missed them: Rebuild Collection's
plan/confirmation and progress screens, Update Collection's steps, log/report sub-views — they showed
only their own heading + an in-flow "← Back to X" button, with no "Home › <area>". Add the same
`.tool-eyebrow` at the top of **every** view, above its heading.

**The breadcrumb replaces the old in-flow back buttons (2026-07-28 decision).** Retire the
`.btn--nav.btn--back` "← Back to <tool>" controls — the breadcrumb's **area segment is now the way
back**: on a sub-view it links to that tool's landing/first view (for Rebuild, the collection picker
— where "Back to Collections" went); on the tool's own landing view it's just the current location
(not a link). **Home** always links to the Home area. One consistent navigation on every view.
(Exception: a genuine *step-back within a multi-step flow* that goes somewhere other than the tool
landing — keep that specific control and flag it.)

**Confirmed during the all-views audit (2026-07-28):** only **Rebuild Collection** has separate
routed sub-views (picker → plan / progress / logs / summary) — every other area (Update Collection,
Rules Generator, all Reports/Utilities sub-tabs) is a single continuous page whose landing eyebrow
already covers it. Its three "← Back to Collections" buttons became breadcrumb links to the picker.
Two back controls were correctly **kept** (not "back to the tool landing," so the breadcrumb doesn't
replace them) — **don't remove these**:
- **Reports → Update Compare's "← Back to …"** — a *cross-tool jump*, not a return to Reports' own
  landing.
- **Archive Finder's "← Back to results"** — an *in-place content swap* within the same view (closes
  the archive tree), not a separate routed view, so it's outside the breadcrumb model entirely.

## Tool page layout — group controls into cards, cap the width (2026-07-28)

A tool page whose body is a stack of loose labels + inputs reads as unstructured (Archive Finder
was the worst offender — a rescan bar, an extensions manager, and a search block all floating with
big gaps, running edge-to-edge on a wide monitor). Two fixes, both reusing what's already here:

- **Group distinct control chunks into `.settings-group` cards** — the same bordered, padded box
  Settings and Update Collection already use. Archive Finder becomes two cards: *Your archive index*
  (scan status + **Save & Rescan** + the file-extensions manager) and *Search* (mode radios + query
  + the Select all / Clear selection / Extract selected actions). One card per "thing the user is
  doing" — not one giant card, not loose controls.
- **Cap the content width** to a comfortable working measure (~1080px, centered), same reasoning as
  Settings' `#settingsPanes` cap. Scope it per tool area — don't touch the shared wide `.app-main`.
- **Copy:** no `(s)` shorthand — "4,526 archive(s)… 12,823 matched file(s)" → "**4,526** archives
  indexed · **12,823** files matched" (the `plain-language-writer` rule against `mod(s)`-style
  syntax). Reference mockup: `design/vortex-archive-finder-mockup.html`.

Apply the same grouping to any other tool page that has grown into a loose stack of controls.

## Stepper — the standard for multi-step tools (2026-07-28)

Some tools are a **sequence**, not a single page: The Forge (Collections → Find files → Review →
Merge → Done) and Update Collection (Backup → Apply Ignores → Apply Disables → Compare). These use a
shared **stepper** — one step per screen — rather than one long scroll. Reference mockups:
`design/vortex-merge-tool-mockup.html` and `design/vortex-update-stepper-mockup.html`.

Why: each step is a natural stopping point, the screen stays short (no scrolling to find "what do I do
now"), and each step earns room to breathe or grow without bloating a mega-page. Interaction
consistency across tools matters as much as visual consistency — a stepper in one tool and a scroll in
another is a seam.

**The pattern:**
- A **step indicator** row on top (`.stepper`): numbered pills — current = `--accent`, completed =
  `--success` with a ✓, upcoming = muted. Below it, a single `#stage` renders only the current step.
- **One step per screen.** The step's controls live in a card; nothing from the other steps shows.
- **Back / Next** nav at the bottom; Next is the primary action, labeled with its destination
  ("Next: Apply Ignores →"). Back is hidden on the first step.
- **Precondition-first.** If a step must only run at a certain time ("before you click Update in
  Vortex," "only after you've closed Vortex"), that condition is a **callout at the top of the step**,
  not buried mid-paragraph. A hard "Vortex must be closed" requirement keeps the app's established
  serious-register + 🛑 treatment.

**Navigable vs. linear — pick by whether the user leaves mid-flow.** The Forge is one sitting, and its
steps have hard prerequisites (you can't Review before you've picked plugins), so its pills are a
**progress indicator only** — you move with Back/Next and in-step back-links ("← Add more files"), not
by jumping ahead. Clickable jump-pills are reserved for re-entry flows (below), where skipping around
is legitimate. Update Collection is **re-entered
between steps** — the user leaves to act in Vortex (run the update, resume the install) and comes
back — so its pills are **fully clickable to jump to any step**, and state persists across navigation;
it is NOT a locked "Next-only" wizard that resets. When a flow interleaves with actions outside the
app, make the stepper navigable and remember where the user was.

**Persistent header for a shared selector.** When every step operates on one selection (Update
Collection's Profile + Collection), that selector is a **persistent bar above the stepper**, set once
and always visible — not a step you redo. (The Forge's "Collections" is a genuine first step because
choosing them *is* the first action — use judgment per tool.)

**Between-step handoffs.** When the user must go do something outside the app before the next step, end
the step with a quiet "→ Next, over in Vortex: …" callout telling them exactly what to do and that
their place is saved. That connective tissue is the thing a single scroll can't give you.

## Selectable lists — the standard select-and-act pattern (2026-07-28)

**One selection pattern for every list the user checks items in and then acts on** — Archive
Finder's results, Vortex Scrub / Clean Up (needs-review, main, cross-check), the Settings exclude
lists, and any future one. Build it as **one reusable helper/component** so every list stays in
sync, not copy-pasted per page. Two tiers: the **core** affordances apply to *every* such list; the
**paginated-table extras** apply only when the list is long enough to page. Reference mockup:
`design/vortex-results-table-mockup.html`. This supersedes and extends the older "Checkbox list +
Select all + bulk action(s)" note under Core components.

### Core — every select-and-act list

- **Controls:** `Select all · Invert selection · Clear selection` on the left; the bulk/primary
  action (`Delete all (N)` / `Extract selected (N)` / `Remove all (N)` …) **right-aligned**, set
  apart from the selection controls. **Invert** covers "pick a few, act on the rest."
- **Live count** — a `N of M selected` readout by the controls, and **the count on the action
  button** so the scope of a bulk/destructive step is always visible.
- **Shift-click range select** on the checkboxes — click one, shift-click another, toggle everything
  between. The biggest time-saver in a long list.
- **Row states never go bright/white** — hover `--surface-2`; a checked row a faint `--accent-bg`
  (plus a 3px inset `--accent` edge if it's a table row). Consistent checkbox styling
  (`accent-color: var(--accent)`).

### Paginated-table extras — long lists (e.g. Archive Finder results)

- Render as a standard `.plan-table` in `.plan-table-wrap` (uppercase-muted sticky header, hairline
  dividers, rounded wrapper), with a subtle **zebra** (`nth-child(even)` ~2% white) under the
  hover/selected states.
- **Selection persists across pages and page-size changes** — track selected ids independent of what
  is rendered. Losing selection on paging breaks the whole flow.
- **Page-vs-all scope** — the header checkbox selects the *visible page*; when more results exist,
  show a thin banner "All N on this page are selected. Select all M results?" (the Gmail/GitHub
  pattern).
- **Reset selection on a NEW search / new result set** — but keep it across paging within the same
  results.
- **"Show selected only" toggle** to review the selected set before acting.
- **Readable names, not raw strings** — strip the Nexus-style `-<id>-<ver>-<timestamp>` tail when it
  parses confidently (fall back to the full name); full filename in the `title` tooltip; a
  hover-revealed **copy button (⧉)** copies the full path (Settings downloads folder + filename),
  flipping to ✓ on copy. "N matching files" expanders are a quiet caret + accent text, not a heavy
  button.

**Confirmed during the build (2026-07-28) — two calls the mockups didn't capture, both kept:**
- **Button labels are Title Case in this app** — "Select All", "Invert Selection", "Clear
  Selection", "Extract Selected" (matching the established convention: "Delete All", "Save &
  Rescan", "View Collection", "Load Vortex Data"). This overrides the mockups' sentence case and the
  plain-language sentence-case default — internal consistency wins (the `plain-language-writer`
  skill's own "consistency can outrank the rule"). **Use Title Case for button labels app-wide;** the
  design mockups often show sentence case, but the app's Title Case is the source of truth.
- **The selection bar is shared across both Archive Finder modes** — "Find individual files" and
  "Display Archive" (tree browse) use the same bar for their Extract flow, so it stays visible in
  both. Scoping selection UI to files-mode would silently break the tree mode's pre-existing Extract
  — the "mockup governs look, the app governs what it does" rule again.

## Spacing — give stacked things room, consistently (2026-07-28)

Elements should never sit flush on top of each other, and the gap between them should be
*consistent* so a page reads with an even rhythm instead of a random mix of 12/16/20px. Default to
breathing room — when in doubt, add air, not remove it.

- **Between stacked cards / sections** (`.settings-group`, `.sync-phase`, the tool-page cards, the
  two-pane content blocks): a consistent **24px (1.5rem)** vertical gap. Never flush. Existing
  components on 16–20px margins should converge on this.
- **Tool-hero → first card / section:** the same ~24px of air below the banner before the first
  block.
- **Prefer a container `gap` over per-element margins** where practical — `display: flex;
  flex-direction: column; gap: 24px` (or grid `gap`) on the wrapping stack keeps spacing uniform by
  construction and avoids collapsed/doubled margins. Fall back to a single consistent bottom margin
  only where a shared container isn't practical.
- This rule governs the **gaps between big blocks**, not padding *inside* a card (keep the existing
  internal rhythm of section sub-labels and field groups).
- **Does NOT apply to** (confirmed 2026-07-28, correctly left untouched during the rollout):
  `.callout` margins (shared across nested/inline contexts — a global change ripples everywhere);
  Home's launcher grid (`.home-grid` gap, `.home-section-title`), a separate already-reviewed
  pattern; and dense repeating rows (`.mm-row`, `.plan-table` rows, tight control rows) — those are
  list items, not stacked cards, and keep their own tighter rhythm.

Confirmed 2026-07-28 from the Archive Finder "Search" card sitting flush under the "Your archive
index" card — the user wanted air between them. Reflects a standing preference for generous
whitespace over cramped, stacked layouts.

## Contextual error placement — put failure feedback where the user is already looking (2026-07-28)

A page-level error box rendered once near the top of a long, scrolling list (e.g. Missing Masters'
own `#mmCriticalError`) is easy to miss when the action that triggered it lives far down that list.
Confirmed real, reported as "nothing happened, no error, no warning" THREE separate times before
being traced to this: the message was rendering correctly every time, just off-screen above the
user's current scroll position. Two fixes, in order of preference:
1. **If the failure is tied to a specific row/item, render it INSIDE that row**, in a callout
   already living there (or a new one placed right next to the existing one), not in a shared
   top-of-page box. The user is already looking at that row — that's where the answer belongs.
2. Only fall back to a page-level box (with `scrollIntoView` if you do) for failures that aren't
   tied to any specific item (e.g. the whole page failed to load).

When a row already has its own callout with useful info (e.g. "Missing Files in Staging Folder"
naming the specific staging folder), don't overwrite its content with a NEW failure message — insert
the new one alongside/above it instead. Overwriting loses real information (confirmed real: doing
this once lost the folder-name reference the original message gave, which the failure message alone
didn't repeat).

## State a known outcome as fact, not a hedged conditional (2026-07-28)

If the app already knows the current value of a relevant setting/condition at the moment a message
is written, state the outcome as plain fact rather than hedging with "if `[setting]` is turned on…".
Example: Missing Masters' Rebuild This Mod confirm dialog reads the actual current value of
"Download missing archives automatically" and says either "This downloads **X**'s archive and
reinstalls it…" or "This restores **X**'s files into your staging folder…" — never "if the setting
is on, we'll try to download it," since the app already knows which case applies by the time the
dialog needs to say anything. Reserve genuinely conditional phrasing for outcomes that really are
uncertain at write-time (e.g. "you may still run into in-game glitches or missing content").

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
  cancel), `.btn--small` as a size modifier on any of the above. **`.btn--nav.btn--back` ("← Back to
  X") is retired (2026-07-28)** — the tool-page breadcrumb replaces in-flow back navigation (see
  "Tool page breadcrumb — name where you are"). Don't add new back buttons; use the breadcrumb.
- **Cards**: `.settings-group` / `.sync-phase` — a bordered, padded box for a distinct chunk of a
  page (Settings' three tool-area cards, Update Collection's four numbered steps).
- **Badges & status-pills**: `.badge` (a small pill, usually with a count) and `.status-pill` (a
  colored label inside a table cell). Generic severity variants exist for both —
  `.badge--info/success/warning/critical/neutral` and
  `.status-pill--info/success/warning/critical/neutral` (added 2026-07-25 for the Compare Report,
  meant to be reused by anything future, not just that one report).
- **The "click stats to filter a list" pattern — multi-select toggle** (upgraded 2026-07-28 from
  single-select; reference mockup `design/vortex-filter-multiselect-mockup.html`): `.badge--clickable`
  + a `data-status` attribute, paired with table/list rows carrying a matching `data-status`. Each
  badge is an **independent toggle** — click to add its status to the visible set, click again to
  remove it — so several can be active at once and the list shows the **union** of every active
  status (e.g. Missing + Disabled on, Pending filtered out). `.badge--show-all` clears all toggles.
  This is **general to every tool**, not per-list behavior. The standard:
  - **None selected = show everything**, with `.badge--show-all` in the active state. This is the
    default/resting state — the filter-chip model users know from Gmail/GitHub — **not** "every badge
    must be on to see all." (Replaces the old single-select "click one badge, it replaces the last.")
  - **No dead-end:** turning the last active status off falls straight back to show-all (everything),
    so the user can never land on an empty list.
  - **Active vs inactive is explicit:** an active badge fills with its status color + a ✓; an inactive
    one goes quiet (muted chip + a small status-color dot) so it still reads as available.
    `.badge--show-all` mirrors the same active/inactive treatment.
  - Visible set = rows whose `data-status` is in the active set (all rows when none active). Same
    small inline filter script, generalized from single- to multi-select — build it once and share it.
  This is **the** standard way to narrow a categorized list in this app. Used by Stats Report's
  Current Issues, Work Through Report, the Ignored/Disabled report, Update Compare, Missing Masters,
  Archive Finder, and the Merge review. **Any new report or list that shows categorized data copies
  this exact mechanism** (badges above, one combined table/list below) rather than inventing per-page
  filtering, multiple stacked tables, or a collapsible-sections approach.
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
- **Grouped table rows with a tri-state group checkbox** (added 2026-07-28, Archive Finder's file
  search): when consecutive result rows share a parent (e.g. several matched files inside the same
  archive), collapse them into one toggle row (`▶`/`▼` + "N matching files") with its own checkbox
  that reflects the children's combined state — unchecked, checked (all children checked), or
  `indeterminate` (some but not all checked). Reuse this whenever a flat result list has a natural
  one-to-many grouping, rather than either flattening it (losing the relationship) or forcing every
  child into its own top-level row.
- **Client-side pagination via a page-size button row**: `Show: 10 · 25 · 50 · All` as a row of
  `.btn--ghost`/`.btn--primary` toggle buttons (the active size gets `.btn--primary`) plus `← Prev` /
  `Next →`, same technique as Stats Report's `.stats-period-btn` — no new CSS class needed. Reuse
  this for any future list large enough to need paging rather than a numbered-page-picker or infinite
  scroll.

## Informational name lists — collapsed neutral chips (2026-07-28)

A read-only list of item names where **no action is needed** (Rules Generator's "Nothing to do"
bucket — mods added to the new collection with no relationship to anything in the original) is the
lowest-priority content on the page. Instead of a full-width, one-name-per-row list, tuck it behind
a **collapsed disclosure** that expands to a wrapping row of **neutral chips**.

- Keep the section's **"Nothing to do" neutral badge** header visible. Under it, a `<details>`
  styled as a quiet row — summary like `▸ <count> mods added with nothing needed — show them`, the
  caret rotating on open. Reuses the app's existing disclosure / "+N more / show less" convention;
  collapsed by default.
- Expanded body: a `flex; flex-wrap: wrap; gap: 8px` of chips. Each chip: `background:
  var(--neutral-bg); border: 1px solid var(--border); color: var(--text-muted); border-radius: 8px;
  padding: 6px 12px; font-size: 13px` — reuses the neutral severity color the section's own badge
  already uses, so it reads as one set. The chips are non-interactive labels.
- The point: demote the least-important section to match its importance (it's noise), while keeping
  it tidy and pleasant when opened ("pretty noise"). Reuse this treatment for any future "here's the
  set, nothing to do about it" list. Reference mockup: `design/vortex-nothing-todo-mockup.html`
  (the "Chips, collapsed" treatment).

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

## Brand theming framework — names, icons & color as data, not code (2026-07-28, v1.0)

There are now **two orthogonal theming layers**, and they must stay independent:

1. **Appearance** (the section above) — dark / light / follow-system, driven by the shared CSS
   variables. Unchanged. This is *how bright the room is.*
2. **Brand** (this section) — the app's identity: its name, each tool's name, emoji, hero copy,
   accent color, and eventually banners. This is *whose room it is.* The whole point: a Skyrim
   player and a Fallout player run the **same binary** and see the tool branded for **their** game,
   with byte-for-byte identical functionality underneath.

Appearance and Brand compose freely — Skyrim-brand in light mode, Plain-brand in dark mode, any
combination. Never entangle them.

### The golden rule of the framework

**Every brand string and the accent color are DATA, read from the active theme at runtime. Nothing
about behavior, layout, or tool identity is.** A tool is referenced everywhere in code by a **stable
tool ID** that never changes; only its *presentation* (name/emoji/copy/accent) is looked up from the
theme. Swapping themes swaps what the user reads and the accent hue — never what a button does, which
API it calls, or where a card routes.

If you ever find yourself about to hardcode a tool's display name, emoji, or hero title in markup or
JS again, stop — it belongs in the theme map, keyed by the tool's stable ID.

### The theme object (schema)

One theme = one plain-data object (its own JSON file, `web/public/themes/<id>.json`):

```jsonc
{
  "id": "plain",                    // stable, lowercase; the localStorage value
  "label": "Plain",                 // what the (future) picker shows
  "appName": "Vortex Collection Tools",
  "accent": "#5b8def",              // the ONE color a theme sets in v1.0 (Plain keeps today's blue)
  "palette": {},                    // RESERVED — empty in v1.0; full per-game palettes fill this later
  "tools": {
    "rebuild":  { "name": "Rebuild Collection", "emoji": "⚡",
                  "heroTitle": "Rebuild Collections in Minutes, Not Hours",
                  "function": "Rebuild Collection" },   // ← plain functional label, see below
    "merge":    { "name": "Merge Plugins", "emoji": "🧬",
                  "heroTitle": "…", "function": "Merge Plugins" }  // 🔨 is the Skyrim "The Forge" emoji, NOT Plain's
    // …one entry per stable tool ID
  }
}
```

- `accent` is the **only** color v1.0 exposes. Everything downstream (buttons, links, focus rings,
  active badges, icon chips via `--accent-bg`) already reads `--accent`, so setting this one variable
  re-tints the whole app for free and safely.
- `palette` is a **reserved, empty slot** in v1.0. It exists now so full per-game palettes
  (`--bg`/`--surface`/`--surface-2`/`--border`/`--text`) can be filled in later as pure data with
  **zero re-plumbing**. Do not populate it in v1.0.
- **Severity colors are NEVER themed.** `--success`/`--warning`/`--danger`/`--neutral` carry meaning,
  not brand, and stay constant across every theme. Not even the deferred full-palette work touches
  them.

### Stable tool IDs — the contract

These IDs are the permanent join between code and theme. They must match `shell.js`'s `TOOL_AREAS`
keys and never change once shipped:

`home`, `rebuild`, `update`, `rules`, `merge` (The Forge, new in v1.0), `missing-masters`, `scrub`,
`archive-finder`, `settings`, and the four reports `report-stats`, `report-workthrough`,
`report-compare`, `report-rules`.

### Name for flavor, subtitle for function — the discoverability rule

A fantasy name alone ("The Forge") tells a new user nothing about what the tool does. So **every
themed tool carries a constant plain-language functional label** (`function` in the schema) that does
**not** change between themes. The branded name is the headline; the functional label always rides
with it (as the card's second line / the hero's eyebrow), so "The Forge" always visibly means "Merge
Plugins." Plain theme's `name` and `function` are simply identical.

### v1.0 ships exactly one theme: Plain

**Plain** holds **today's exact strings and today's blue accent**, extracted verbatim from the
current `index.html` — the app looks and reads *identically* to v0.4 after the refactor. That's the
success criterion: the plumbing is proven end-to-end by a theme that changes nothing visible. The
build pass is a pure **extract-and-indirect refactor**, not a redesign.

Plain theme content = the current values already in the app (do not rewrite them):

| Tool ID | Emoji | Name | Hero title |
| :-- | :-- | :-- | :-- |
| `home` | 🧰 | Home | Your Whole Vortex Toolkit, in One Place |
| `rebuild` | ⚡ | Rebuild Collection | Rebuild Collections in Minutes, Not Hours |
| `update` | 🔄 | Update Collection | Update Without Redoing Your Mod Cleanup |
| `rules` | 🔗 | Rules Generator | Skip Re-Resolving Conflicts You Already Fixed |
| `merge` | 🧬 | Merge Plugins | Merge Many Plugins Into One *(new in v1.0)* |
| `missing-masters` | 🧩 | Missing Masters | Triage Missing Masters in Seconds |
| `scrub` | 🧽 | Vortex Scrub | Scrub Away Clutter in Seconds |
| `archive-finder` | 📦 | Archive Finder | Find Any File Inside Any Archive |
| `report-stats` | 📊 | Stats | See Every Rebuild at a Glance |
| `report-workthrough` | ✅ | Work Through | Work Through Every Problem Mod, One by One |
| `report-compare` | 🔍 | Update Compare | See Exactly What an Update Changed |
| `report-rules` | 📋 | Rules Generator Report | Check Your Rules Generator Progress |
| `settings` | ⚙️ | Settings | Set It Up Once, Use It Everywhere |

The `.tool-hero__body` paragraphs and Home card pitches come across **verbatim** too — the build pass
lifts the current copy into the theme map; it does not rewrite it.

### Runtime (engineer-facing summary; full detail → TECHNICAL.md)

On boot: read the active theme ID from `localStorage` (default `plain`) → set `--accent` (and, later,
any `palette` keys) on `:root` → fill every brand slot in the DOM (app title, tool-hero titles/bodies,
breadcrumbs, Home card names/emoji/pitches, settings labels) from the active theme's `tools` map by
stable ID. One source of truth; no brand string appears twice.

### Deferred to after v1.0 (pure data + one UI piece — NOT this milestone)

- **Game themes** as new JSON files (Skyrim, Fallout, Starfield, …) — name/emoji/hero/`function`
  per tool + an `accent`.
- **Full per-game palettes** — filling the reserved `palette` slot.
- **The game/theme picker UI** and the optional "pick your game on first launch" moment.
- **Per-game banners.**

Draft Skyrim name map (flavor only — captured so it isn't lost; each still pairs with its constant
functional label): The Arcaneum = `home`, Restoration = `rebuild`, The Ward = `update`, The Scribe =
`rules`, **The Forge = `merge`**, The Augur = `missing-masters`, The Cleansing = `scrub`,
Clairvoyance = `archive-finder`, The Chronicle = `reports`.

## Home / landing page — card-based launcher (2026-07-28)

The app opens on a **Home** page — a card-based launcher for every tool — instead of dropping the
user straight into Rebuild Collection. One glanceable place to choose where to go. Reference mockup:
`design/vortex-home-mockup.html` (open in a browser); full handoff prompt in `design/BUILD-PROMPT.md`.

**The top nav row is removed.** With Home acting as the launcher, the old five-tab `.app-nav`
(Rebuild Collection / Update Collection / Rules Generator / Reports / Utilities) is redundant and
comes out. Navigation now happens two ways: pick a card on Home, or click the app-header logo/title
(`.app-header__title`) to return Home from anywhere. Every tool page already has its own in-page
"Back" affordance for stepping back within a flow. The trade-off (switching directly tool-to-tool
now routes through Home instead of one click across the top) is deliberate and accepted for the
launcher model. Settings stays exactly where it was — the gear at the header's far right.

**The logo/title is the Home control.** `.app-header__title` gains a pointer cursor and a
`var(--surface-2)` hover, and returns Home on click. The header meta/breadcrumb on the right still
names the current area (reads "Home" on the landing page) so the user always knows where they are.

**Layout.** A `.tool-hero` welcome banner (🧰 title + one casual orientation sentence — Home reuses
the app's own intro-banner pattern, not a bespoke header), then grouped card sections:
- **Main tools** — Rebuild Collection ⚡, Update Collection 🔄, Rules Generator 🔗
- **Reports** — Stats 📊, Work Through ✅, Update Compare 🔍, Rules Generator Report 📋
- **Utilities** — Missing Masters 🧩, Vortex Scrub 🧽, Archive Finder 📦

Reports and Utilities show their **sub-tools expanded** as individual cards, so every destination in
the app is one click from Home. Section labels reuse the `.settings-section-title` treatment (12px
uppercase, letter-spaced, muted).

**New pattern — `.home-card` / `.home-grid` / `.home-section-title`.** Nothing existing covered a
clickable tool-launcher card, so this is added here as the shared convention. Built entirely from
existing tokens and the `.settings-group` recipe — no new colors:
- `.home-grid`: `repeat(auto-fill, minmax(280px, 1fr))`, `gap: 16px`. Cap the Home content to
  ~1280px, centered — the shared `.app-main` is deliberately wide (1800px, for data tables), which
  leaves the cards clustered left on a big monitor; scope the cap to Home only, don't touch
  `.app-main` (2026-07-28).
- **Equal-height cards.** `.home-card-wrap` and `.home-card` are `height: 100%`, so cards in a row
  match height and — with `.home-card__desc { flex: 1 }` — the "Open →" link pins to the bottom
  (2026-07-28).
- `.home-card`: the `.settings-group` surface / border / `--radius` / padding, made clickable —
  hover lifts it (`translateY(-2px)`) and switches the border to `--accent` with `--shadow` (the
  same accent-on-hover language as `.btn--ghost` and the old `.nav-tab`). Use a real `<button>` (or
  `<a>`) so it's keyboard-focusable, with a visible `:focus-visible` outline.
- `.home-card__icon`: a 44px rounded chip, `background: var(--accent-bg)`, holding the tool's emoji
  (the same one already used in that tool's own `.tool-hero__title`).
- Name at 17px/600 (matching `.settings-group__header h2`); a one-line description in `--text-muted`;
  an accent "Open →" affordance.

**Icon chips stay accent-tinted, never severity-colored.** Deliberate: green/amber/red carry real
meaning in this app (success / warning / critical). Color-coding launcher cards per tool would
dilute that, so every chip uses the neutral `--accent-bg`. Don't "brighten it up" with per-tool
colors.

**Voice.** Casual register (a launcher page isn't consequential). Each card's one-line pitch is a
condensed version of that tool's own `.tool-hero__body` "What & Why" — same promise, trimmed to one
line. Load `plain-language-writer` before touching this copy.

**Pinnable.** Each card carries a star (`.home-card__star`, top-right corner); pinned tools surface
in a **📌 Pinned** row above the category sections. See the "Pinning" section below for the shared
rules.

The wiring detail (adding a `home` area to shell.js's `TOOL_AREAS`, making it the default landing,
removing the `.app-nav` markup, routing each card through the same `showToolArea()` the old nav
buttons used, and Reports/Utilities cards landing on their default sub-tab) is engineer-facing —
document it in `TECHNICAL.md` when built, not here.

## Settings — two-pane category layout (2026-07-28)

Settings was one long vertical scroll of stacked `.settings-group` cards (a big "General" block
plus one card per tool). Replaced with a **two-pane layout**: a sticky category rail on the left,
and the selected category's cards on the right — one section visible at a time, so the page is
short and scannable instead of a single long scroll. Reference mockup:
`design/vortex-settings-mockup.html` (open in a browser); handoff prompt in
`design/BUILD-PROMPT-settings.md`.

**The page header is a `.tool-hero` intro banner**, not a plain heading — an emoji-led title (⚙️)
plus a casual "What & Why" body, exactly like every tool page (see the "Tool intro banner" section
above). It replaces the old `<h1>Settings</h1>` + one-line subtitle. The Restart Server / Stop
Server actions sit in a right-aligned row just below the banner (above the two panes) — moved there
2026-07-28 because they're used infrequently and were cluttering the space above the rail's colorful
icons.

**One *logical* form (not a literal `<form>` element), panes shown/hidden — not separate forms.**
Every field stays in the DOM at all times; switching category only toggles which pane is visible.
The single **Save Settings** button gathers every field via JS and writes them all at once, so
edits made in one category are never lost by switching to another before saving. This is the
load-bearing rule — get it wrong and switching categories silently drops unsaved changes.
**Do not wrap the fields in an actual `<form>` element** (there isn't one, deliberately): inside a
form, every button (Save, Browse, Delete, Restore, Add…) defaults to `type="submit"`, so pressing
Enter in a text field could fire the wrong button. The existing JS Save handler already does the
all-at-once write — keep it. Anti-autofill is handled with per-input `autocomplete="off"` (+
`data-lpignore`/`data-1p-ignore`/`data-form-type="other"` on the API-key field), not a form.

**Category rail — `.settings-rail` / `.settings-rail__item`.** A vertical list of the settings
categories, sticky under the header. Each item is the tool's emoji + label; the active one uses
`--accent-bg` + `--accent` text (the same accent-selection language used everywhere else —
deliberately NOT a severity color, which would imply meaning here). A real `<button>` per item,
keyboard-focusable, built from existing tokens. On narrow widths (<820px) the rail wraps to a
horizontal row above the content. The content column (`#settingsPanes`) is capped to ~960px so
callouts and hints wrap at a comfortable reading width instead of running edge-to-edge on a wide
monitor (2026-07-28).

**Categories and order — tool sections first, set-once config last:**
1. ⚡ Rebuild Collection
2. 🔄 Update Collection
3. 🧩 Missing Masters
4. 🧽 Vortex Scrub
5. 📦 Archive Finder
6. 📁 Paths & Backups — Vortex staging / downloads / database paths, database backups, logs
7. ⚙️ General — theme, server (port/host + the security-warning callout), Nexus API key,
   download-missing-archives, version warning

**This order is static — hand-picked, never auto-reordered by usage.** A settings nav that
reshuffles itself by frequency breaks the muscle memory of "it's the 4th item," which for
navigation you return to repeatedly costs more than an "optimized" order gains. Put the important
things up top once (done) and leave the order fixed. (Session memory is fine and different: the
page may remember the *last-open* category across a save-reload — that doesn't move any item.)

**The rail is pinnable** (`.settings-rail__pin` — a star that appears on row hover, stays visible
once pinned). Pinned categories move into a **📌 Pinned** group at the top and leave the main list;
the remaining categories keep their static order. See the "Pinning" section below.

The old single "General" block was split into **Paths & Backups** (where files live) and **General**
(how the app behaves) — that block was the bulk of the old scroll, and separating locations from
behavior makes both easier to scan. Rules Generator has no settings of its own (it shares the
database backups under Paths & Backups), so it isn't a rail item.

**Sticky Save bar — `.settings-save-bar`.** The Save Settings primary button pins to the bottom of
the content pane, always in reach regardless of which category is open; a muted "All changes saved."
hint sits to its left after a save. The Restart Server / Stop Server actions sit in a right-aligned
row between the banner and the panes (see the header note above).

**Components unchanged; section copy refreshed.** Every field reuses the existing `.settings-group`
card, `.settings-section-title` sub-labels, `.field-group` / `.field-label` / `.input` / `.select`
/ `.checkbox`, and the `.callout--warning` security box; no field is removed or renamed. The
per-section **blurbs and hints were rewritten to the friendly casual voice** (see the mockup) — each
should say what its tool does in plain words, not a technical description (e.g. Missing Masters'
"Read-only — this feature only ever reads…" became "Point Missing Masters at your Skyrim files here.
It only reads these folders…"). The **security warning stays serious**. All copy follows
`plain-language-writer`. Wiring detail (which `settings-app.js` render calls move into which pane,
the show/hide toggle, last-open memory) is engineer-facing — put it in `TECHNICAL.md` when built.

**Mockups are design references, not content specs.** The `design/` mockups pin down layout,
structure, and voice — they deliberately simplify real content for brevity. When a mockup trims
real content or functionality, **keep the real thing**: this is a reorganization, not a feature or
disclosure trim. Confirmed 2026-07-28 (three good calls during the Settings build): kept the Nexus
key's plaintext-storage security disclosure and its "get your key" link; kept Vortex Scrub's
interactive exclude-list management (the mockup showed only a count); and kept the accurate
"changes need a restart" note under Server. Rule of thumb: the mockup governs *how it looks and
reads*; the existing app governs *what it does and must disclose*.

## Pinning — favorites on Home and the Settings rail (2026-07-28)

One "pin" concept, used in two places, so it reads as a single feature: a star pins an item into a
dedicated **📌 Pinned** zone for quick access. This is the mechanism that keeps the app navigable as
it grows — at 20–30 tools you pin the handful you use and they're always one click away.

- **Home** — each `.home-card` carries a star (`.home-card__star`, top-right). Pinned tools appear
  in a **📌 Pinned** row above the category sections.
- **Settings rail** — each rail row has a star that appears on hover (`.settings-rail__pin`, and
  stays visible once pinned). Pinned categories appear in a **📌 Pinned** group above the rest of
  the list.

Shared rules:
- **Pinning MOVES an item into the Pinned zone — it does not duplicate it.** A pinned tool/category
  leaves its category section (Home) or the main rail list (Settings) and shows *only* in the
  **📌 Pinned** zone, so each item appears exactly once (decided 2026-07-28 — the earlier
  additive/duplicate version read as clutter). The *remaining* items keep their static relative
  order — pinning lifts items out, it never reorders or usage-ranks the rest. On Home, hide a
  category section that becomes empty because all its cards are pinned. Hide the Pinned zone
  entirely when nothing is pinned.
- **The star uses `--accent`, not a severity color** — a filled `★` in accent when pinned, an
  outline `☆` otherwise. (A red 📌 pushpin glyph would collide with the danger severity, so 📌 is
  used only as the decorative zone label, never as the toggle.)
- **No flicker.** Toggling a pin moves one item between the Pinned zone and its section/list, so
  re-render just those two regions — never the whole page (the header/hero stay put), and never in a
  way that flashes. (Confirmed clean on Home 2026-07-28.)
- **Persist the pins** so they survive a reload. The mechanism (config vs. `localStorage`) is
  engineer-facing — decide in `TECHNICAL.md`; a personal local tool can use either.

**Future-proofing — define each tool once.** As tools are added, describe each in a single place —
its emoji, its `.tool-hero` title, and its one-line pitch — and let its Home card, its page hero,
and its Settings rail item all read from that source. Adding a tool then becomes one data entry plus
its pane, not copy duplicated across three screens that can silently drift apart.

## How this document gets used

- Read this file before making **any** visual or user-facing change — new pages, new modals, a
  restyled report, new copy, anything the user will actually see.
- If an existing pattern already covers what's needed, use it as-is, unmodified.
- If something genuinely new is needed, design it consistent with everything above, then **add it to
  this document in the same change** — this file is only useful if it stays current.
- This is a standing instruction enforced via this project's own `CLAUDE.md`, which every future
  Claude Code session in this repo loads automatically — see that file for the exact pointer.
