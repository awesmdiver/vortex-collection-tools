# Terminal prompt queue

**Send the Pending items below, top to bottom.** Open in a markdown preview (VS Code: `Ctrl+Shift+V`)
for copy buttons. The design side keeps this current — single source of truth for "what's left." Run
one at a time (several touch the same files).

---

## Pending — send these

### 1 · Adaptive completion — green banner, skip empty steps, + spacing
*No-disables case: green "you're done" banner, Next skips the empty Apply Disables, breathing room fix.*

```
Update Collection stepper — completion banner should be GREEN, Next must skip empty steps, + a spacing
fix. Load plain-language-writer. See DESIGN.md "Stepper — Adaptive steps + a completion state".

1) GREEN COMPLETION BANNER (the main one). The "You're almost there!" / end-of-flow banner currently
   renders as a BLUE .callout--info; it's a completion / success state, so it should be GREEN
   (.callout--success). (User recalls it was green originally — check whether it regressed from
   success→info.) When all APPLICABLE required steps are done (e.g. Backup + Apply Ignores, with no
   disables to apply), show a green success callout that says the TOOL's work is done — e.g. "✅ You're
   done here! Nothing left in this tool for this collection — just reopen Vortex, click **Resume** to
   finish the update, and have fun gaming. (Compare below is optional if you want a before/after.)"
   Fold in the existing "Resume in Vortex" guidance; drop the now-redundant "you can skip Apply
   Disables" line.

2) NEXT SKIPS EMPTY STEPS. When the collection has no disabled mods, MUTE the Apply Disables (step 3)
   pill (greyed, nothing-to-do, still clickable) and make Next SKIP it — after Apply Ignores, Next
   reads "Next: Compare →" and goes to step 4, not the empty step 3. (You already enable Next in the
   nothingToDo branch; extend it to mute the pill + relabel/redirect Next.) Generalize to any empty
   required step.

3) SPACING. Add breathing room between the Profile/Collection selector dropdowns and the stepper pill
   row — they're cramped now (the header-tighten removed the row that separated them). Match the app's
   stack spacing.

Verify light + dark, npm run web: a collection with ignores but no disables → green completion after
Apply Ignores, step 3 muted, Next → Compare; a collection WITH disables → normal flow (step 3 active,
Next → Apply Disables). Document in TECHNICAL.md; write your wrap-up to prompts/handoff-latest.md.
```

### 2 · Ratio-warning refinement — floor + per-collection dismiss + Settings
*Stops small-collection false positives; lets the user silence it per collection.*

```
Refine the Update Collection backup ratio warning (buildBackupRatioWarning + the render/dismiss around
sync-app.js:527-577). Load plain-language-writer. Do NOT touch the backup-FRESHNESS warning.

1) ABSOLUTE FLOOR. Add BACKUP_RATIO_WARNING_MIN_COUNT = 15 alongside the existing 0.03 threshold. A
   count trips the warning only when BOTH > 3% of totalCount AND >= 15. Apply per ignored/disabled
   independently. Document both constants (floor 15 so counts like 2-5 never warn; tunable).

2) PERSISTENT PER-COLLECTION DISMISS. Persist dismissals keyed by collection modId in a gitignored
   personal-state JSON (like work-through-state.json; add to .gitignore). Survives restarts/days. A
   "This is normal for this collection" link on the callout records it; that collection never warns
   again (others unaffected).

3) SETTINGS RE-ENABLE. A "Backup heads-up reminders" item in Settings (Update Collection group) showing
   how many collections are silenced + a button to clear the store. Copy:
   - Dismiss link: This is normal for this collection
   - Confirmation: Got it — we won't flag this again for **{collection}**. Turn these reminders back on
     anytime in Settings.
   - Settings label: Backup heads-up reminders
   - Settings body: Before a backup, we flag any collection with an unusually large share of mods
     Ignored or Disabled — a nudge in case it was accidental. You've marked **{N} collection(s)** as
     normal, so we skip the nudge for those.
   - Settings body when N=0: You haven't silenced this for any collections yet.
   - Settings button: Remind me for all collections again

Verify: 2-of-40 → no warning; 41-of-100 → warns; dismiss → gone for that collection even after a server
restart; a different collection still warns; Settings reset brings them all back. Light+dark. Document
in TECHNICAL.md; write your wrap-up to prompts/handoff-latest.md.
```

---

## ✅ Done
- **Disabled-count bug** — phantom "1 disabled" fixed (`f4976ab`)
- **Step 2/3 polish** — chip-grid previews, bold action hints, pluralization (`16ebbc7`)
- **Header tighten** — "Show Ignored & Disabled" onto the stepper row (`4f600d1`)
- **Next-gating** — Applied ✓ done-state, one primary, sticky + Preview re-arm, Backup keeps
  Next-gating only (no sticky flip) — *verified live; committing now*

---

## Roadmap after the queue (order set 2026-07-28)
1. Finish this queue.
2. **Workflow board** — build the standalone dev tool (`utilities/claude-workflow-board`).
3. **Theming** — brand-theming framework (Plain theme first).
4. **Dynamic dashboard** — Normal/Developer audience mode + add/remove tools in Settings.

*(Harmonization folds into the theming/dashboard era. Theming + the warm/fun voice apply to BOTH
audiences — Developer mode only adds tools.)*

**Revisit (review-only, fire anytime):** does the Next-gating standard apply to The Forge's stepper?
The Forge's action (Merge) *is* the advance, so the two-primary ambiguity likely doesn't occur —
terminal reviews and reports (no code changes); we decide from that.
