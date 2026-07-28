# Build prompt — Settings two-pane reorganization

Paste into Claude Code from the repo root. Visual target: `design/vortex-settings-mockup.html`
(open in a browser). Design decisions + component spec: `DESIGN.md`'s "Settings — two-pane
category layout" section.

---

Reorganize the **Settings page** into a two-pane layout — a sticky category rail on the left, one
category's settings on the right — so it's no longer one long scroll. Keep the exact look,
components, fields, and voice; this is purely a reorganization, not a redesign.

First read `CLAUDE.md`, `DESIGN.md` (the "Settings — two-pane category layout" section plus the
components and severity sections), and **load the `plain-language-writer` skill** before touching
any copy. Open `design/vortex-settings-mockup.html` and match it.

**Non-negotiable — no data loss:**
- Keep Settings as **one *logical* form — NOT a literal `<form>` element** (there is none, and
  adding one would make the inner buttons default to `type="submit"`, so Enter in a field could
  fire the wrong one). Panes are show/hide only; every field stays in the DOM, and the single
  **Save Settings** button gathers them all via JS and writes at once. Switching category must
  never discard unsaved edits made in another category. Verify this explicitly.

**Conventions (DESIGN.md):**
- Reuse existing tokens and components — no hardcoded colors, no one-off stylesheet. The new
  `.settings-rail` / `.settings-rail__item` / `.settings-save-bar` classes go in
  `web/public/styles.css`.
- The rail's active state uses `--accent-bg` only — never a severity color.
- No field is removed or renamed. **Apply the refreshed section blurbs and hints from the mockup**
  (already run through `plain-language-writer` and approved by the user), and give every *remaining*
  settings string the same casual plain-language pass — say what each tool does in plain, friendly
  words, not a technical description. The one exception: the **security warning** under General →
  Server stays in its serious register, unchanged.

**Implement:**
1. **Split** the current single "General" block into two categories — **General** (theme, server +
   the security-warning callout, Nexus API key, download-missing-archives, version warning) and
   **Paths & Backups** (Vortex staging / downloads / database paths, database backups, logs).
   Also replace the plain `<h1>Settings</h1>` + subtitle with a `.tool-hero` intro banner (⚙️ title
   + a casual What & Why body, per the "Tool intro banner" convention), keeping Restart / Stop
   Server beside it.
2. **index.html** (settings area) — wrap the settings cards in the two-pane layout: `.settings-layout`
   (rail + content), a `.settings-rail` of category buttons, each area as a `.settings-pane` holding
   its existing `.settings-group` card(s). Rail order — **tool sections first, then the set-once
   config last**: Rebuild Collection, Update Collection, Missing Masters, Vortex Scrub, Archive
   Finder, Paths & Backups, General. This order is **static** (hand-picked, never auto-reordered by
   usage). Move the Save Settings button into a sticky `.settings-save-bar` at the bottom of the
   content pane; put Restart / Stop Server in a right-aligned row between the tool-hero banner and
   the panes (infrequent actions, kept clear of the rail's icons).
3. **web/public/styles.css** — add `.settings-layout`, `.settings-rail`, `.settings-rail__item`
   (+ active + `__icon`), `.settings-rail__row`, `.settings-rail__pin`, `.settings-rail__group`,
   `.settings-rail__divider`, `.settings-pane`, `.settings-save-bar`, matching the mockup.
   Responsive: the rail wraps to a horizontal row under ~820px.
4. **settings-app.js** — show/hide panes on rail click; default to the first category; remember the
   last-open category (e.g. `localStorage`) so a save-triggered reload returns to the same pane.
   Confirm all existing per-field load/save logic still runs for currently-hidden panes (it should,
   since the fields stay in the DOM).
5. **Rail pins** (see DESIGN.md's "Pinning" section) — a `.settings-rail__pin` star on each rail row
   (appears on hover, stays visible once pinned). **Pinning MOVES a category** into a **📌 Pinned**
   group at the top — it leaves the main list (no duplicate); the remaining categories keep their
   static order. Hide the Pinned group when empty; persist the pins; star is `--accent`; re-render
   just the pinned group + list, no flicker.

**Then document + verify:**
- The `DESIGN.md` section is already written; add the engineer-facing wiring detail (which
  `settings-app.js` render calls move into which pane, the toggle, last-open memory) to
  `TECHNICAL.md` in the same change.
- Run `npm run web` and confirm: every category shows the right fields; switching categories keeps
  edits; Save writes everything at once; the security warning still shows under General → Server;
  light and dark both look right; and nothing reads differently from before beyond the new layout.
