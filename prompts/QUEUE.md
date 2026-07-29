# Terminal prompt queue

**Send the Pending item below.** Open in a markdown preview (VS Code: `Ctrl+Shift+V`) for copy buttons.
The design side keeps this current — single source of truth for "what's left."

---

## Pending — send this

### 1 · Ratio-warning refinement — floor + per-collection dismiss + Settings
*Last queue item before the v0.5.0 release.*

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
- **Next-gating** — Applied ✓ done-state, one primary, sticky + Preview re-arm (`3a19fc3`)
- **Adaptive completion** — green "you're done here" banner, Next skips the empty step, spacing fix —
  *done + verified; committing now*

---

## Then → **v0.5.0 release** (relay already provided): version bump → THIRD-PARTY-NOTICES check →
build-release.ps1 → gh release with the notes + zip.

## Known minor follow-up (post-v0.5.0, not blocking)
- Re-doing Apply Ignores via **Preview** doesn't clear a stale end-of-flow banner ("you're done" /
  "next steps") until Apply re-succeeds. Pre-existing; wire callout-clearing into the Preview re-arm in
  a later polish pass.

## Roadmap after the release
Workflow board → theming (first game theme: `design/theme-content-skyrim.md`) → dynamic dashboard.
