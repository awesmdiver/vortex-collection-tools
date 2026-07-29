# Terminal prompt queue

**Queue is CLEAR** — all Update Collection work is done and committed (`f928c74`). The only remaining
action is the **v0.5.0 release** below.

---

## → NEXT: v0.5.0 release

```
Release v0.5.0 — the queue is clear (all Update Collection work committed as f928c74).
1. Bump package.json 0.4.0 → 0.5.0.
2. Verify THIRD-PARTY-NOTICES.md fully covers the bundled xeditlib / XEditLib.dll (MPL) + the wrapper (MIT).
3. Run build-release.ps1 → produces github-releases/VortexCollectionTools-v0.5.0-win-x64.zip.
4. Commit the version bump + any docs touched; push.
5. gh release create v0.5.0 --notes-file github-releases/release-notes-v0.5.0.md and upload the zip
   (VortexCollectionTools-v0.5.0-win-x64.zip) as the asset. The notes reference
   assets/release-v0.5.0-banner.png (already committed & pushed, so it renders).
Then write your wrap-up to prompts/handoff-latest.md.
```

Release prep already done (design side): README updated (The Forge in Overview + step-by-step note),
`github-releases/release-notes-v0.5.0.md` written (Forge-led), banner renamed to
`assets/release-v0.5.0-banner.png` and pushed.

---

## ✅ Done (all committed)
- **Disabled-count bug** — phantom "1 disabled" fixed (`f4976ab`)
- **Step 2/3 polish** — chip-grid previews, bold action hints, pluralization (`16ebbc7`)
- **Header tighten** — "Show Ignored & Disabled" onto the stepper row (`4f600d1`)
- **Next-gating** — Applied ✓ done-state, one primary, sticky + Preview re-arm (`3a19fc3`)
- **Adaptive completion + ratio-warning + dismiss re-key** — green "you're done here" banner, Next
  skips empty step, spacing; ratio floor(15) + per-collection dismiss (keyed by collection NAME so it
  survives updates) + Settings re-enable (`f928c74`)

## Known minor follow-up (post-v0.5.0, not blocking)
- Re-doing Apply Ignores via **Preview** doesn't clear a stale end-of-flow banner until Apply
  re-succeeds. Pre-existing; wire callout-clearing into the Preview re-arm in a later polish pass.

## Roadmap after the release
Workflow board (`utilities/claude-workflow-board`, scaffolded) → theming (first game theme:
`design/theme-content-skyrim.md`) → dynamic dashboard (Normal/Developer mode).
