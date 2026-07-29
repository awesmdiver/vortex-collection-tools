# Terminal prompt queue

**Send the Pending items below, top to bottom.** Open in a markdown preview (VS Code: `Ctrl+Shift+V`)
for copy buttons. The design side keeps this current — this file is the single source of truth for
"what's left." Run them one at a time (several touch the same files).

---

## Pending — send these

### 1 · Gate "Next" on each step's required action
*So a distracted user always knows whether they've acted (the Apply/Next "did I or didn't I?" fix).*

```
Update Collection stepper — gate "Next" on each step's required action, and show the action's done
state. See DESIGN.md "Gate 'Next' on a step's required action". Load plain-language-writer.

Apply Ignores (step 2) + Apply Disables (step 3):
- Next starts DISABLED; enabled only after Apply succeeds. (The Preview → Apply gating stays; this adds
  Apply → Next on top.)
- Never two accent/primary buttons at once: while pending, Apply is the only primary and Next is
  disabled/secondary.
- On a successful Apply, flip the button: "Apply" → "Applied ✓", disabled, styled as done
  (quiet/success, not the live accent). Then enable Next and make Next the primary.
- Re-apply (rare): the "Applied ✓" state is STICKY — don't leave Apply permanently live. To act again,
  clicking Preview re-runs and re-arms Apply. Preview stays available after Apply. MAKE IT
  DISCOVERABLE — in the done state show a small hint, e.g. "✓ Applied — {N} mods set to Ignored. Need
  to redo it? Just hit **Preview** again." (bold Preview per the bold-action-in-hints rule).
Backup (step 1): same logic — Next disabled until a backup is created (Create Backup → "Backup
created", Next enables). A backup with nothing to save still counts as done; flag if unsure.
Compare (step 4): no gating (optional, last step). Keep the navigable stepper pills freely clickable.

Verify light + dark, npm run web: fresh step → Next disabled; after Apply → button reads "Applied ✓"
(disabled) and Next enables. Document in TECHNICAL.md; write your wrap-up to prompts/handoff-latest.md.
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

---

## Roadmap after the queue (order set 2026-07-28)
1. Finish this queue.
2. **Workflow board** — build the standalone dev tool (`utilities/claude-workflow-board`).
3. **Theming** — brand-theming framework (Plain theme first).
4. **Dynamic dashboard** — Normal/Developer audience mode + add/remove tools in Settings.

*(Harmonization folds into the theming/dashboard era. Theming + the warm/fun voice apply to BOTH
audiences — Developer mode only adds tools.)*

**Revisit (review-only, fire anytime):** does the Next-gating standard (#1) apply to The Forge's
stepper? The Forge is a one-sitting flow with no leave-and-return step, and its main action (Merge)
*is* the advance — so the two-primary "did I act?" ambiguity likely doesn't occur. Rather than wait on
manual testing, **terminal reviews The Forge's stepper logic and reports whether/where the standard
applies** (no code changes); we decide from that. Doesn't block the two pending builds above.
