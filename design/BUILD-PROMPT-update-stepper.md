# Build prompt — Update Collection → stepper

Restructure the **Update Collection** tool from its current single-scroll layout (four stacked
numbered step cards) into the shared **stepper** pattern — one step per screen — matching The Forge.
This is a UI/flow restructure: **all existing functionality and logic stays exactly the same.**

Read first:
- `DESIGN.md` → "Stepper — the standard for multi-step tools" (the pattern, plus the navigable-vs-
  linear and persistent-header rules).
- `design/vortex-update-stepper-mockup.html` — the approved flow. Open it; click the step pills and
  Back/Next.
- Load the `plain-language-writer` skill for any copy you touch.

## The flow

**Persistent header (above the stepper, always visible — NOT a step):** the breadcrumb
`Home › Update Collection`, the tool-hero, and the **Profile + Collection selector + "Show Ignored &
Disabled"** bar. Set once, stays put across every step.

**Stepper: Backup → Apply Ignores → Apply Disables → Compare.** The pills are **clickable to jump to
any step** — the user leaves to Vortex and comes back mid-flow, so do NOT lock it to Next-only, and
keep each step's state when navigating away and back. Use the **same stepper CSS/markup The Forge
already has — share it, don't fork a second implementation.**

Per step (promote today's buried "run BEFORE / AFTER" text to a callout at the TOP of the step):

1. **Backup** — precondition callout (info): "Do this before you click Update in Vortex." The existing
   Create Backup / Restore Backup controls. End with a between-step handoff callout:
   *"→ Next, over in Vortex: click Update on this collection and let it run, then close Vortex. Come
   back for Apply Ignores — your place is saved."* Then Next: Apply Ignores →.
2. **Apply Ignores** — precondition callout in serious register, matching the app's established 🛑
   "Vortex must be closed" treatment: "Only after you've updated the collection in Vortex and closed
   it." Keep the existing "writes to Vortex's database — a full backup is taken first" note, the
   Updated-Vortex-collection-id field (with its autofill-on-Preview behavior), and Preview / Apply
   (Apply enabled only after Preview). End with a handoff callout: *"→ Next, over in Vortex: resume the
   collection's install, let it finish, then close Vortex again. Then continue to Apply Disables."*
   Back + Next: Apply Disables →.
3. **Apply Disables** — precondition callout, same serious + 🛑 close-Vortex treatment: "Only after
   you've resumed the update install and closed Vortex." Preview / Apply. Back + Next: Compare →.
4. **Compare** — info callout: "Optional — run anytime." The existing Generate Report control. Back
   only (last step).

## Rules

- **Preserve every existing behavior:** Backup/Restore, the collection-id autofill-on-Preview,
  Preview→Apply gating, the Vortex-running block, Compare's report generation. Presentation only — no
  logic changes.
- Reuse the app's existing components/tokens; share The Forge's stepper implementation rather than
  duplicating it.
- Breadcrumb eyebrow `Home › Update Collection` on every step (per the breadcrumb rule).
- The two database-write steps stay serious register and match the app's established close-Vortex
  phrasing/icon exactly (flag any inconsistency rather than inventing a new one).
- Verify light + dark, and walk all four steps plus the jump-around navigation with `npm run web`.
- Document the restructure in `TECHNICAL.md`; write your wrap-up to `prompts/handoff-latest.md` per
  `CLAUDE.md`.
