# BUILD PROMPT — ESLifier awareness (Settings path + Missing Masters soft-warning)

Teach the tools to recognize files ESLifier generated, so they stop being reported as anomalies.
Full requirements + background: workspace `TODO.md` → `vortex-tools/vortex-collection-tools` →
"Missing Masters — filter externally light-flagged (ESL) mods." v1 scope = **Settings path + Missing
Masters downgrade**. (Broader "teach other tools too" — Vortex Scrub, Rebuild — is a deliberate
fast-follow; don't build it now.)

Standing rules that apply: `CLAUDE.md` (voice register — casual here, read-only + a severity
*downgrade*, nothing consequential), `DESIGN.md` (reuse existing components; add the soft tier there —
see §2). **Design owns the user-facing copy — it's drafted below; use it as-is (flag back if a real
case makes a line wrong), don't rewrite it.**

---

## ✅ The detection — confirmed from live data (user screenshot, 2026-07-29)

Not a hypothesis anymore. The false positive is the **`findActiveAlternate` → "Name Collides With a
Different Mod"** branch in `lib/missing-masters-scan.js` (an `activeAlternate` with
`sameModAsMaster: false`). The confirmed live case:

- Missing master **DBM_SkyrimSewers_Patch.esp** (its own mod: *Legacy of the Dragonborn Patches
  (Official)*), needed by 2 plugins → shown 🔴 **critical**, callout **"Manual Action Needed: Name
  Collides With a Different Mod."**
- The scan finds an active file whose **true deployed source (from `vortex.deployment.json`) is
  `ESLifier Output`** — and the current callout literally says so, then hedges: *"we can't tell whether
  ESLifier Output's version is meant to replace it, so that decision is yours."*

**The app already surfaces the true source.** The whole feature is: when that true source resolves to
the **configured ESLifier output folder**, we DO know it's deliberate — so replace that red hedging
callout with the soft, reassuring one and drop the row to the soft tier.

**Detection rule (concrete):** in `scanMissingMasters`, when a problem-master's `activeAlternate` has a
true source (`activeAlternate.modName` = the deployment-manifest `source`) that matches the configured
`eslifierOutputDir`, set `eslifierSwap: true` on that master; the UI keys the soft treatment + copy off
that flag. **One thing to confirm against the live manifest:** the `source` is a stripped
staging-folder name (here, `"ESLifier Output"`) — verify how that lines up with the configured path
(match on the folder's basename, or resolve the mod's staging path against `eslifierOutputDir`),
whichever is reliable on the real data. The *signal* is nailed; only the source↔path comparison needs a
quick live check.

---

## 1. Settings — ESLifier output folder

- New config field `eslifierOutputDir: null` in `lib/app-config.js` (and **update `config.example.json`**
  — the header comment warns this silently drifts). **Path field → restart-required**, same as
  `dummyMastersOutputDir` et al. **Blank is a supported state** (like `archiveFinderOutputDir`) — the
  feature is simply inert until it's set; don't block Save on it.
- A **Browse…** folder picker, mirroring the existing path-picker fields exactly.
- A small **helper/info icon** using the app's external-link convention (opens in its own window per
  DESIGN.md), linking to ESLifier's **Nexus Mods page** — grab the real mod URL at build time from
  github.com/MaskPlague/ESLifier or a Nexus search; **don't guess the mod id.**

**Copy — the Settings section blurb** (casual):

> **ESLifier output folder**
> Point us at your ESLifier output folder here. ESLifier is a separate tool that shrinks eligible
> plugins into the lighter ESL format and updates everything that points at them, saving the results
> in its own folder. Tell us where that folder is and our tools will treat those files as intentional
> — instead of mistaking the swap for a problem.

Helper-icon link label: **Learn more about ESLifier**

---

## 2. Missing Masters — recognize ESLifier output, downgrade to a SOFT tier

- A **toggle, ON by default**, persisted (`missingMastersRecognizeEslifier: true` — a non-path toggle,
  read **fresh per scan, no restart**, like `downloadMissingArchives`; add to `config.example.json`).
  Place it on the Missing Masters page as a scan option.
- When ON and a master is `eslifierSwap` (per the detection above): drop it from 🔴 critical to a
  **soft, muted tier that sits BELOW the normal 🟠 warning** — the user's explicit call: *"a little
  more muted than a normal warning."* This isn't an alert, it's a calm "yep, that's intentional" note.
  **Stays visible — never hidden.** Reach for the app's **calmest existing treatment** first —
  `callout--info` (neutral, quieter than the orange warning) for the note, with the row + badge muted
  to match, **not** `callout--warning`/`callout--critical`. If Missing Masters' own row styling has no
  tier below `mm-row--warning`, add a muted variant in code and **flag it in the handoff so the design
  side folds the "soft / acknowledged" tier into `DESIGN.md`** (DESIGN.md is design-owned — don't edit
  it from the build). Badge label: **ESLifier**.
- This specifically **replaces the existing "Manual Action Needed: Name Collides With a Different Mod"**
  critical callout (the `activeAlternate && !sameModAsMaster` render) for ESLifier-sourced collisions —
  same row, soft tier, new copy.
- **Empty-state:** if `eslifierOutputDir` isn't set, the toggle can't match anything — show a short
  hint pointing to Settings rather than a dead toggle.

**Copy — the toggle** (casual):

> **Recognize ESLifier output**
> When a file traces back to your ESLifier output folder, we'll show it as a quiet heads-up instead of
> a missing-master alert — the swap is on purpose, so there's nothing to fix.

**Copy — the toggle's empty-state hint:**

> Add your **ESLifier output folder** in **Settings** to use this.

**Copy — the soft note that replaces the red "Name Collides" callout** (casual, reassuring — this is
the intentional swap, not a problem):

> **You swapped this one on purpose — nothing to fix.** A lighter, compressed copy of **{MasterName}**
> from your **ESLifier output folder** is active instead of the original, exactly the way you set it up
> in Vortex. It looks like a name collision, but it's working just as you meant it to.

---

## 3. Verify + handoff

- Toggle OFF → behavior byte-identical to today (still the red "Name Collides" callout). Toggle ON + a
  collision whose source is NOT the ESLifier folder → unchanged (still critical — a real collision).
  Toggle ON + the confirmed ESLifier case (e.g. the DBM_SkyrimSewers_Patch.esp / ESLifier Output row
  above) → soft tier + the reassuring copy.
- Round-trip both new config fields through `config.example.json`.
- Handoff to `prompts/handoff-latest.md`: what you built, **exactly how the manifest `source` matched
  the configured folder** (so the design side knows the final comparison), the real Nexus URL you used,
  the DESIGN.md soft-tier addition, and anything user-facing for the README/Key Features.
