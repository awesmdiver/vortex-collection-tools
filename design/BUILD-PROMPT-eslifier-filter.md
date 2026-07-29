# BUILD PROMPT — ESLifier awareness (Settings path + Missing Masters downgrade)

Teach the tools to recognize files ESLifier generated, so they stop being reported as anomalies.
Full requirements + background: workspace `TODO.md` → `vortex-tools/vortex-collection-tools` →
"Missing Masters — filter externally light-flagged (ESL) mods." Read that first; this is the build
order. v1 scope = **Settings path + Missing Masters downgrade**. (Broader "teach other tools too"
— Vortex Scrub, Rebuild — is a deliberate fast-follow; don't build it now.)

Standing rules that apply: `CLAUDE.md` (voice register — casual here, this is read-only + a severity
*downgrade*, nothing consequential), `DESIGN.md` (reuse existing components — path picker, external-link
helper, callouts, the Missing Masters severity classes). **Design owns the user-facing copy — it's
drafted below; use it as-is (flag back if a real case makes a line wrong), don't rewrite it.**

---

## ⚠️ The one hard part: the detection must be verified against LIVE data, not assumed

This is the disabled-count situation again — the clean hypothesis was wrong there, and the real cause
only showed up in the user's actual Vortex data. **Do not ship a guessed detection rule.** The exact
way an ESLifier-generated file "traces to the ESLifier output folder" depends on (a) ESLifier's real
output naming/structure and (b) how Vortex deploys it — both of which you must confirm live.

**Sequence:**
1. **Reproduce the false positive first.** With the user's real ESLifier output folder configured, run
   the live Missing Masters scan and *observe which signal actually fires* — is the offending master
   reported as `missing`, `present-but-inactive`, or surfaced via `activeAlternate` /
   `deployedMisplaced`? Attach the downgrade to whatever the real case turns out to be, not a guess.
2. **Read ESLifier's output naming** from its source (github.com/MaskPlague/ESLifier) so the trace is
   reliable — how it names/places the flagged/compacted/patched files it writes.
3. **Candidate hook (hypothesis to verify, not gospel):** `lib/missing-masters-scan.js` already reads
   `vortex.deployment.json` via `readDeploymentManifest()` — each deployed file records its `source`
   (staging folder). If ESLifier's output is deployed through Vortex, the file actually in use should
   trace, via that `source`, back to the configured ESLifier output folder. That trace is the likely
   basis for an `eslifierSwap` flag on the problem-master. **Confirm this is actually how the user's
   ESLifier→Vortex setup deploys before relying on it** — if ESLifier output becomes its own Vortex mod
   with a different staging path, the `source` won't equal the configured folder and the rule needs to
   match on something else.
4. Snapshot/verify nothing else regresses: the existing missing / present-but-inactive / ready-to-deploy
   / active-alternate cases must be unaffected when the toggle is off, and for any master that does NOT
   trace to ESLifier.

---

## 1. Settings — ESLifier output folder

- New config field `eslifierOutputDir: null` in `lib/app-config.js` (and **update `config.example.json`**
  — the header comment warns this silently drifts). It's a **path field → restart-required**, same as
  `dummyMastersOutputDir` et al. **Blank is a supported state** (like `archiveFinderOutputDir` /
  `mergeOutputDir`) — the feature is simply inert until it's set; don't block Save on it.
- A **Browse…** folder picker, mirroring the existing path-picker fields exactly.
- A small **helper/info icon** using the app's external-link convention (opens in its own window per
  DESIGN.md), linking to ESLifier's **Nexus Mods page** — grab the real mod URL at build time from
  github.com/MaskPlague/ESLifier or a Nexus search; **don't guess the mod id.**

**Copy — the Settings section blurb** (casual; says what it's for, plain, complete sentences):

> **ESLifier output folder**
> Point us at your ESLifier output folder here. ESLifier is a separate tool that shrinks eligible
> plugins into the lighter ESL format and updates everything that points at them, saving the results
> in its own folder. Tell us where that folder is and our tools will treat those files as intentional
> — instead of mistaking the swap for a problem.

Helper-icon link label: **Learn more about ESLifier**

---

## 2. Missing Masters — recognize ESLifier output, downgrade critical → warning

- A **toggle, ON by default**, persisted (`missingMastersRecognizeEslifier: true` in config — a
  non-path toggle, read **fresh per scan, no restart**, same convention as `downloadMissingArchives` /
  `hideVortexVersionWarning`; add it to `config.example.json` too). Place it on the Missing Masters
  page as a scan option/filter.
- When ON: any problem-master whose file traces to the ESLifier output folder (per the verified
  detection above) is **downgraded from 🔴 critical (`mm-row--critical`) to 🟠 warning
  (`mm-row--warning`, `badge--warning`)** — *surfaced, not hidden*. Give it its own badge label:
  **ESLifier**. Replace the critical callout on that row with a calm, reassuring one (an
  informational/warning callout, **not** `callout--critical`).
- **Empty-state:** if `eslifierOutputDir` isn't set, the toggle can't match anything — show a short
  hint pointing to Settings rather than a dead toggle.

**Copy — the toggle** (casual):

> **Recognize ESLifier output**
> When a file traces back to your ESLifier output folder, we'll flag it as a heads-up instead of a
> missing master — the swap is on purpose, so there's nothing to fix.

**Copy — the toggle's empty-state hint** (when no ESLifier folder is set yet):

> Add your **ESLifier output folder** in **Settings** to use this.

**Copy — the downgraded row callout** (casual; reassuring — this is a genuine false positive, the file
is fine):

> **This one's an ESLifier swap — nothing to fix.** **{MasterName}** was replaced by an ESL-flagged
> version from your ESLifier output folder, so even though it looks missing, it's working exactly as
> intended.

*(If the real case surfaces via `present-but-inactive` or `activeAlternate` rather than `missing`,
keep the same reassuring message but adjust "looks missing" to fit what the row actually shows — flag
the wording back to the design side if unsure.)*

---

## 3. Verify + handoff

- Toggle OFF → behavior is byte-identical to today. Toggle ON but a master that doesn't trace to
  ESLifier → unchanged (still 🔴 if genuinely missing). Toggle ON + a real ESLifier-swapped master →
  🟠 warning with the reassuring callout.
- Round-trip the two new config fields through `config.example.json` (don't let it drift).
- Handoff to `prompts/handoff-latest.md`: what you built, **what the real ESLifier→Vortex deploy
  actually looked like and which signal the false positive fired on** (so the design side learns the
  true mechanism), the real Nexus URL you used, and anything user-facing for the README/Key Features.
