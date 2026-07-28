# Build prompt — Home landing page (card-based launcher)

Paste into Claude Code from the repo root. Visual target: `design/vortex-home-mockup.html` (open in
a browser). The design decisions and the new component spec live in `DESIGN.md`'s
"Home / landing page — card-based launcher" section — implement to match both.

---

Add a **Home landing page** to Vortex Collection Tools — a card-based launcher for every tool — so
the app opens on Home instead of dropping the user straight into Rebuild Collection.

First read `CLAUDE.md`, then `DESIGN.md` (especially the "Home / landing page — card-based launcher"
section), and **load the `plain-language-writer` skill** before writing any copy. Open
`design/vortex-home-mockup.html` in a browser and match it — it's built entirely from this app's own
tokens and components, so it should feel seamless with every other page.

**Conventions (from DESIGN.md — non-negotiable):**
- Reuse existing tokens and components. No hardcoded color literals, no one-off stylesheet. The new
  `.home-card` / `.home-grid` / `.home-section-title` classes go in `web/public/styles.css`, built
  on the `.settings-group` recipe.
- Keep the visual language seamless — a user must not feel Home is a different app.
- Icon chips stay `--accent-bg` only — never severity-colored (green/amber/red carry meaning here).
- All card copy follows `plain-language-writer` (casual register): reuse each tool's existing emoji
  and condense its own `.tool-hero__body` down to a single line.

**Implement:**
1. **index.html** — a new `home` tool-area (`<section id="area-home" class="tool-area">`): the
   `.tool-hero` welcome banner (🧰) plus the three grouped card sections (Main tools / Reports /
   Utilities), sub-tools expanded, exactly as in the mockup. Cards are keyboard-focusable
   `<button>`s. **Remove the five-tab `.app-nav` block from the header** — Home replaces it.
2. **web/public/styles.css** — add `.home-grid`, `.home-card` (+ `__icon` / `__name` / `__desc` /
   `__open`), `.home-card-wrap`, `.home-card__star`, `.home-section-title`, and give
   `.app-header__title` a pointer cursor + `--surface-2` hover (it's now the Home control).
3. **shell.js** — add `'home'` to `TOOL_AREAS`; make Home the **default landing** (replacing the
   current default into Rebuild), while preserving the existing deep-link / last-area routing for
   real navigations; wire the logo/title (`.app-header__title`) to return Home; route each card
   through the same `showToolArea()` the removed nav buttons used. Reports and Utilities cards land
   on that area's default sub-tab. The header meta reads "Home" on the landing page. Check nothing
   else depended on the removed `.app-nav` buttons (active-state toggling, etc.) and clean up any
   now-dead references.
4. Light / dark / system keep working automatically through the CSS variables — just don't hardcode.
5. **Pins** (see DESIGN.md's "Pinning" section) — wrap each card in `.home-card-wrap` with a sibling
   `.home-card__star` button (NOT nested inside the card `<button>` — nested buttons are invalid
   HTML). **Pinning MOVES a card** into a **📌 Pinned** row above the category sections — the card
   leaves its category section (not duplicated); hide a section that ends up empty, and hide the
   Pinned row when nothing is pinned. Persist the pins. The star is `--accent` (not a severity
   color). Toggling re-renders just the Pinned row + affected section — no full-page rebuild, no
   flicker.

**Then document + verify:**
- The `DESIGN.md` section is already written. Add the engineer-facing wiring detail (the
  default-landing change and card routing) to `TECHNICAL.md` in the same change.
- Run `npm run web`, open the app, and confirm: it opens on Home; every card and the logo navigate
  correctly; Reports/Utilities cards land on their default sub-tab; light and dark both look right;
  and there's no visual seam versus the rest of the app.
