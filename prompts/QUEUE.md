# Terminal prompt queue

**Send these to terminal top-to-bottom. Check each off as you send it.** Open this file in a markdown
preview (VS Code: `Ctrl+Shift+V`) so every block has a copy button.

The design side keeps this current: new prompts get added in execution order, finished ones get
removed. Run them **one at a time** (several touch the same files). Order is a suggestion — reorder
freely.

---

## - [x] 1 · Bug — disabled-count miscount — ✅ SHIPPED (f4976ab)
*Shipped 2026-07-28. Real cause wasn't the profile-scoping we first guessed — a same-hash duplicate
install was fooling the identity match. Count now matches Vortex (6 ignored, 0 disabled). **Next up: #2.***

```
BUG — Update Collection backup miscounts "disabled". Repro: a collection whose Vortex Mods tab shows
0 Disabled (all flagged mods are Ignored) still reports "...and 1 disabled mod(s)" in the "Backup
created!" message.

Root cause (confirmed by reading the code): getDisabledInstalledMods (lib/vortex-sync/lib.js:874)
returns EVERY mod disabled in the active profile that's still installed — profile-wide, NOT scoped to
the collection. Its own doc comment says as much. Meanwhile the "ignored" side IS collection-scoped
(counts match Vortex there). So the disabled count includes mods that aren't members of this
collection (or whose collection status isn't Disabled), producing phantom counts like this "1."

Do:
1. DIAGNOSE first: for this collection, dump which mod is the counted "disabled" one (vortexModId +
   name), and confirm whether it's actually a member of this collection and/or collection-Disabled vs
   merely profile-disabled. Report that before changing behavior.
2. Trace the call chain from the backup ("Backup created! ... N disabled mod(s)") through
   getDisabledInstalledMods — is its result ever filtered to the collection's members, or used raw?
3. FIX: scope the disabled set to the collection's own members (the same scoping the ignored side
   uses / what Vortex's collection "Status = Disabled" filter shows), so the count — and what the
   backup captures and Apply Disables later re-disables — only ever covers THIS collection. If there's
   a documented reason it was intentionally profile-wide, reconcile the message instead and flag it.
4. This changes what the backup captures and what Apply Disables writes to Vortex's DB — serious,
   careful. Verify against the real state DB: this collection now reports 0 disabled (matching Vortex),
   and a collection that genuinely has collection-Disabled mods still reports them correctly.

Document in TECHNICAL.md; write your wrap-up to prompts/handoff-latest.md.
```

---

## - [ ] 2 · Step 2/3 polish — chips, bold action, pluralization
*Apply Ignores + Apply Disables preview list → chips; bold the clickable action in hints; fix "mod(s)".*

```
Update Collection stepper — Step 2 (Apply Ignores) + Step 3 (Apply Disables) polish. Three items.
Load plain-language-writer. See DESIGN.md.

1) PREVIEW LIST → NEUTRAL CHIPS (shown, not collapsed). The Preview mod list (currently one-name-
   per-row) becomes the neutral chip grid — DESIGN.md "Informational name lists — collapsed neutral
   chips", the SHOWN variant. Same chip styling as Rules Generator's "Nothing to do" (background
   var(--neutral-bg), 1px var(--border), color var(--text-muted), radius 8px, padding 6px 12px,
   font-size 13px; flex-wrap + gap 8px; non-interactive labels) — but SHOWN by default, NOT behind a
   collapsed disclosure: the user clicked Preview to see it and it precedes a DB write, so it's review
   content, not noise. Keep the existing "+N more / show less" cap for long lists. Apply to BOTH the
   Apply Ignores and Apply Disables previews. Reference: design/vortex-nothing-todo-mockup.html (same
   chip look, shown instead of collapsed).

2) BOLD THE CLICKABLE ACTION IN MUTED HINTS. The muted hint "…leave it blank and we'll grab the
   current id when you click Preview." — bold **Preview** so the action stands out against the grey.
   New standard (DESIGN/voice guide): bold the exact clickable label even inside muted hint/help text.
   Sweep the Update Collection hint text and bold any other unbolded action references (Preview, Apply).

3) PLURALIZATION + STATUS CASING. "Preview — 15 mod(s) will be set to ignored" → "Preview — 15 mods
   will be set to **Ignored**" (pluralize in code, no "(s)"; capitalize + bold the Vortex status to
   match its UI label; singular "1 mod will be set to **Ignored**"). Same for Disabled. Sweep the sync
   screens for other "mod(s)" shorthand.

Verify light + dark, npm run web. Write your wrap-up to prompts/handoff-latest.md.
```

---

## - [ ] 3 · Ratio-warning refinement — floor + per-collection dismiss + Settings
*Stops small-collection false positives; lets the user silence it per collection.*

```
Refine the Update Collection backup ratio warning (buildBackupRatioWarning + the render/dismiss
around sync-app.js:527-577). Three additions. Load plain-language-writer; copy is provided below.
Do NOT touch the backup-FRESHNESS warning — only the ratio ("bigger share than usual") one.

1) ABSOLUTE FLOOR. Add BACKUP_RATIO_WARNING_MIN_COUNT = 15 alongside the existing 0.03 threshold.
   A count trips the warning only when it is BOTH > 3% of totalCount AND >= 15. Apply per
   ignored/disabled independently. Document both constants (tuned to real data; floor 15 so counts
   like 2-5 never warn regardless of collection size; easily adjusted from tester feedback).

2) PERSISTENT PER-COLLECTION DISMISS. Persist dismissals keyed by collection modId in a gitignored
   personal-state JSON (same pattern as work-through-state.json / offsite-import-map.json; add the new
   file to .gitignore). Must survive server restarts and span days. Add a "This is normal for this
   collection" link on the ratio callout; clicking it records the dismissal, and the ratio warning
   then never renders for THAT collection again (others unaffected).

3) SETTINGS RE-ENABLE. Add a "Backup heads-up reminders" item to Settings (Update Collection group)
   showing how many collections are silenced, with a button that clears the store. Copy:
   - Dismiss link: This is normal for this collection
   - Confirmation: Got it — we won't flag this again for **{collection}**. Turn these reminders back
     on anytime in Settings.
   - Settings label: Backup heads-up reminders
   - Settings body: Before a backup, we flag any collection with an unusually large share of mods
     Ignored or Disabled — a nudge in case it was accidental. You've marked **{N} collection(s)** as
     normal, so we skip the nudge for those.
   - Settings body when N=0: You haven't silenced this for any collections yet.
   - Settings button: Remind me for all collections again

Verify: 2-of-40 → no warning; 41-of-100 → warns; dismiss → gone for that collection even after a
server restart; a different collection still warns; Settings reset brings them all back. Light+dark.
Document in TECHNICAL.md; write your wrap-up to prompts/handoff-latest.md.
```

---

## - [ ] 4 · Header tighten — "Show Ignored & Disabled" onto the stepper row
*Reclaims a full row; right-justify it on the stepper line.*

```
Update Collection stepper — tighten the header, reclaim a row. "Show Ignored & Disabled" currently
sits on its own line between the Profile/Collection selector bar and the stepper, costing a full row.
Move it ONTO the stepper row, RIGHT-justified: stepper pills stay left, "Show Ignored & Disabled"
pushes to the right edge of the same row (make the stepper row a flex row; the button gets
margin-left:auto). Keep it the same subtle button it is now. On a narrow window it should wrap
gracefully (drop below the pills) rather than crowd or overlap them. Verify light + dark, npm run web.
Write your wrap-up to prompts/handoff-latest.md.
```

---

## Roadmap after the queue (order set 2026-07-28)
1. **Finish this queue** — incl. the Missing Masters ESLifier filter interlude.
2. **Workflow board** — build the standalone dev tool (`utilities/claude-workflow-board`).
3. **Theming** — the brand-theming framework (Plain theme first).
4. **Dynamic dashboard** — Normal/Developer audience mode + add/remove tools in Settings.

*(Harmonization — slide-out back-port + multi-select filter badges — folds into the theming/dashboard
era. Theming and the warm/fun voice apply to BOTH audiences; Developer mode only adds tools.)*
